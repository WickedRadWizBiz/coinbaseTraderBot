import os
import time
import random
import pathlib
import traceback
from typing import List, Optional
from pydantic import BaseModel, Field
from google import genai
from google.genai import types

DEFAULT_TASK = (
    "Implement the Fast Spot S/R & Volume Profile Engine, the Kalshi Strike Shield & "
    "80/20 Core/Runner Selector, and the Async Execution FSM in TypeScript, and wire "
    "them cleanly into kalshiService.ts, bot/oms/oms.ts, and bot/main.ts."
)


class PlanStep(BaseModel):
    filepath: str = Field(description="Relative path from repo root, e.g., bot/strategy/fastSrConfluence.ts")
    action: str = Field(description="'create' or 'modify'")
    instructions: str = Field(description="Detailed specification of what to write or update in this file")


class ArchitecturePlan(BaseModel):
    summary: str = Field(description="High-level architectural summary of the changes")
    steps: List[PlanStep] = Field(description="Ordered list of files to create or modify (max 6 files)")


class GeneratedFile(BaseModel):
    filepath: str = Field(description="Relative path from repo root")
    explanation: str = Field(description="Brief summary of changes made")
    content: str = Field(description="Complete, valid, production-ready TypeScript source code for the file")


class RelevantFilesSelection(BaseModel):
    filepaths: List[str] = Field(description="List of existing repository filepaths relevant to the task")


IGNORE_DIRS = {".git", "node_modules", "dist", "build", ".next", "__pycache__", ".github"}
ALLOWED_EXTENSIONS = {".ts", ".tsx", ".js", ".json", ".py"}
UNAVAILABLE_MODELS = set()


def get_repo_tree() -> List[str]:
    file_list = []
    for root, dirs, files in os.walk("."):
        dirs[:] = [d for d in dirs if d not in IGNORE_DIRS]
        for f in files:
            if pathlib.Path(f).suffix in ALLOWED_EXTENSIONS:
                file_list.append(os.path.relpath(os.path.join(root, f), "."))
    return sorted(file_list)


def read_files(filepaths: List[str], max_chars_per_file: int = 30000) -> str:
    bundled = []
    for fp in filepaths:
        if os.path.exists(fp) and os.path.isfile(fp):
            with open(fp, "r", encoding="utf-8", errors="replace") as f:
                bundled.append(f"=== FILE: {fp} ===\n{f.read()[:max_chars_per_file]}\n=== END FILE: {fp} ===")
    return "\n\n".join(bundled)


def generate_with_retry(
    client: genai.Client,
    prompt: str,
    thinking_level: str = "low",
    schema_cls: Optional[type] = None,
    prefer_argon: bool = False,
    max_retries: int = 6,
):
    """
    Wraps Gemini calls with exponential backoff for 503/429 spikes.
    Automatically skips unavailable models and steps down from 'high' to 'medium'
    thinking on later retries if the high-thinking queue is congested.
    """
    candidate_models = ["gemini-4-argon", "gemini-3.8-flash"] if prefer_argon else ["gemini-3.8-flash"]
    candidate_models = [m for m in candidate_models if m not in UNAVAILABLE_MODELS]

    for model_name in candidate_models:
        for attempt in range(1, max_retries + 1):
            # Step down to 'medium' thinking on attempts 5+ if 'high' pool is saturated with 503s
            active_thinking = "medium" if (thinking_level == "high" and attempt >= 5) else thinking_level
            token_cap = 16384 if active_thinking == "medium" else 32768

            cfg_kwargs = {
                "max_output_tokens": token_cap,
                "thinking_config": types.ThinkingConfig(thinking_level=active_thinking),
            }
            if schema_cls is not None:
                cfg_kwargs["response_mime_type"] = "application/json"
                cfg_kwargs["response_schema"] = schema_cls

            try:
                print(f"[{model_name}] Attempt {attempt}/{max_retries} (thinking={active_thinking})...")
                resp = client.models.generate_content(
                    model=model_name,
                    contents=prompt,
                    config=types.GenerateContentConfig(**cfg_kwargs),
                )
                if schema_cls is not None:
                    if resp.parsed is not None:
                        return resp.parsed
                    if resp.text:
                        return schema_cls.model_validate_json(resp.text)
                    raise ValueError("Empty structured response from model.")
                return resp.text

            except Exception as err:
                err_str = str(err).upper()
                # If model is not permitted/found on this key tier, cache and switch immediately
                if any(code in err_str for code in ("404", "NOT_FOUND", "403", "PERMISSION_DENIED")):
                    print(f"Model {model_name} not available on this key tier. Switching to fallback...")
                    UNAVAILABLE_MODELS.add(model_name)
                    break

                # Transient 503 / 429 / 500 server demand spike -> exponential backoff with jitter
                is_transient = any(
                    code in err_str
                    for code in ("503", "UNAVAILABLE", "429", "RESOURCE_EXHAUSTED", "500", "502", "504", "OVERLOADED")
                )
                if is_transient and attempt < max_retries:
                    sleep_sec = min(75.0, (5.0 * (1.8 ** (attempt - 1))) + random.uniform(1.0, 5.0))
                    print(f"Transient API spike ({err}). Retrying in {sleep_sec:.1f}s...")
                    time.sleep(sleep_sec)
                    continue

                if model_name != candidate_models[-1]:
                    print(f"Error on {model_name}: {err}. Trying next model...")
                    break
                raise

    raise RuntimeError("All model attempts and retries exhausted.")


def main():
    try:
        api_key = os.environ.get("GEMINI_API_KEY")
        if not api_key:
            raise RuntimeError("GEMINI_API_KEY secret is missing.")

        raw_task = os.environ.get("TASK_PROMPT", "").replace("/gemini-implement", "").strip()
        if not raw_task:
            raw_task = DEFAULT_TASK

        client = genai.Client(api_key=api_key)
        repo_tree = get_repo_tree()
        print(f"Found {len(repo_tree)} source files in repository.")

        # Step 1: Select relevant existing files using gemini-3.8-flash (thinking_level=low)
        flash_selector_prompt = (
            "Repository file tree:\n" + "\n".join(repo_tree) + "\n\n"
            f"Task Request:\n{raw_task}\n\n"
            "Select up to 8 existing files from the repository tree that need to be read or modified "
            "to understand the interfaces and implement this task."
        )
        selection: RelevantFilesSelection = generate_with_retry(
            client,
            flash_selector_prompt,
            thinking_level="low",
            schema_cls=RelevantFilesSelection,
            prefer_argon=False,
        )
        selected_files = selection.filepaths
        print(f"Selected existing files for context: {selected_files}")

        codebase_context = read_files(selected_files)

        # Step 2: Summarize existing interfaces with gemini-3.8-flash (thinking_level=low)
        flash_map_prompt = (
            "Summarize the TypeScript interfaces, class signatures, order execution methods, and imports "
            "in these existing files so our lead architect model can wire new modules in without breaking types:\n\n"
            + codebase_context
        )
        arch_summary: str = generate_with_retry(
            client,
            flash_map_prompt,
            thinking_level="low",
            schema_cls=None,
            prefer_argon=False,
        )

        reference_spec = (
            "Required Architecture Specifications:\n"
            "1. Fast Spot S/R & Volume Profile Engine (bot/strategy/fastSrConfluence.ts):\n"
            "   - O(N) sliding window extrema + 1D ATR histogram binning (0.5 * ATR bins).\n"
            "   - Incremental Volume Profile returning Point of Control (POC), High Volume Nodes (HVN), and Low Volume Nodes (LVN).\n"
            "   - Dynamic Ichimoku Kijun-sen (26) and Senkou Span B (52) equilibrium levels.\n"
            "2. Kalshi Strike Shield & 80/20 Core + Runner Selector (bot/strategy/kalshiSrSelector.ts):\n"
            "   - Reciprocal Kalshi order book parser: Implied YES Ask = 1.00 - Best NO Bid; Implied NO Ask = 1.00 - Best YES Bid.\n"
            "   - Filters for strikes shielded behind the active spot S/R zone (below support for YES bounce, above resistance for NO rejection).\n"
            "   - Quadratic taker fee formula: ceil(0.07 * contracts * price * (1 - price) * 100) / 100.\n"
            "   - 80/20 Core + Runner split sized to achieve $4.50 net profit on the 80% Core scalp (+12c target) while capping total contracts at top-of-book ask depth.\n"
            "3. Async Execution State Machine (bot/oms/kalshiExecutionFsm.ts):\n"
            "   - States: IDLE -> PLACING_ENTRY -> WAITING_FOR_FILL -> MANAGING_POSITION -> COMPLETED / CANCELED.\n"
            "   - Posts resting Maker (post_only) take-profit order for 80% Core contracts on entry fill.\n"
            "   - Arms breakeven stop on the 20% Runner once the 80% Core TP fills.\n"
            "   - Uses Promise.allSettled for parallel order cancellations in OMS.\n"
        )

        # Step 3: Build file-by-file implementation plan at HIGH thinking
        plan_prompt = (
            "You are a Principal Quant Architect planning an implementation for a TypeScript trading bot.\n"
            f"User Task:\n{raw_task}\n\n"
            f"{reference_spec}\n\n"
            f"Interface Map:\n{arch_summary}\n\n"
            "Create a concise step-by-step file plan (maximum 6 files) listing each new file to create "
            "and each existing file to wire into."
        )
        plan: ArchitecturePlan = generate_with_retry(
            client,
            plan_prompt,
            thinking_level="high",
            schema_cls=ArchitecturePlan,
            prefer_argon=True,
        )
        print(f"Architecture Plan Summary:\n{plan.summary}")

        # Step 4: Generate each file individually with 4s pacing between calls to prevent burst 503s
        generated_context = ""
        for idx, step in enumerate(plan.steps[:6]):
            if idx > 0:
                time.sleep(4.0)

            existing_target = read_files([step.filepath]) if os.path.exists(step.filepath) else "NEW FILE"
            file_prompt = (
                "You are a Principal Quant Architect writing production TypeScript code.\n"
                f"Overall Plan:\n{plan.summary}\n\n"
                f"{reference_spec}\n\n"
                f"Repository Interface Map:\n{arch_summary}\n\n"
                f"Previously Generated Files in This Run:\n{generated_context}\n\n"
                f"Current Target File ({step.action.upper()}): {step.filepath}\n"
                f"Specific Instructions: {step.instructions}\n\n"
                f"Existing Content of {step.filepath}:\n{existing_target}\n\n"
                "Return the COMPLETE, valid, production-ready source code for this file without placeholders."
            )
            gen_file: GeneratedFile = generate_with_retry(
                client,
                file_prompt,
                thinking_level="high",
                schema_cls=GeneratedFile,
                prefer_argon=True,
            )
            target_path = pathlib.Path(step.filepath)
            target_path.parent.mkdir(parents=True, exist_ok=True)
            with open(target_path, "w", encoding="utf-8") as f:
                f.write(gen_file.content)
            print(f"Wrote file: {step.filepath} ({gen_file.explanation})")
            generated_context += f"\n=== GENERATED: {step.filepath} ===\n{gen_file.content[:12000]}\n"

    except Exception:
        print("An error occurred during the AI implementation pipeline:")
        traceback.print_exc()
        exit(1)


if __name__ == "__main__":
    main()

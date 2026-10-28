import os
import pathlib
import traceback
from typing import List
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


def call_high_thinking_structured(client: genai.Client, prompt: str, schema_cls):
    """
    Tries gemini-4-argon (thinking_level=high) first; falls back to gemini-3.8-flash (thinking_level=high).
    Uses the 32,768 non-streaming token cap and validates JSON fallback if .parsed is None.
    """
    high_cfg = types.GenerateContentConfig(
        max_output_tokens=32768,
        thinking_config=types.ThinkingConfig(thinking_level="high"),
        response_mime_type="application/json",
        response_schema=schema_cls,
    )
    for model_name in ("gemini-4-argon", "gemini-3.8-flash"):
        try:
            print(f"Calling {model_name} (thinking_level=high)...")
            resp = client.models.generate_content(
                model=model_name,
                contents=prompt,
                config=high_cfg,
            )
            if resp.parsed is not None:
                return resp.parsed
            if resp.text:
                return schema_cls.model_validate_json(resp.text)
        except Exception as err:
            print(f"Model {model_name} attempt failed: {err}")
            if model_name == "gemini-3.8-flash":
                raise
    raise RuntimeError("Failed to generate structured output from both models.")


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

        selection_resp = client.models.generate_content(
            model="gemini-3.8-flash",
            contents=flash_selector_prompt,
            config=types.GenerateContentConfig(
                thinking_config=types.ThinkingConfig(thinking_level="low"),
                response_mime_type="application/json",
                response_schema=RelevantFilesSelection,
            ),
        )
        selected_files = (
            selection_resp.parsed.filepaths
            if selection_resp.parsed
            else RelevantFilesSelection.model_validate_json(selection_resp.text).filepaths
        )
        print(f"Selected existing files for context: {selected_files}")

        codebase_context = read_files(selected_files)

        # Step 2: Summarize existing interfaces with gemini-3.8-flash (thinking_level=low)
        flash_map_prompt = (
            "Summarize the TypeScript interfaces, class signatures, order execution methods, and imports "
            "in these existing files so our lead architect model can wire new modules in without breaking types:\n\n"
            + codebase_context
        )
        arch_summary = client.models.generate_content(
            model="gemini-3.8-flash",
            contents=flash_map_prompt,
            config=types.GenerateContentConfig(
                thinking_config=types.ThinkingConfig(thinking_level="low")
            ),
        ).text

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
        plan: ArchitecturePlan = call_high_thinking_structured(client, plan_prompt, ArchitecturePlan)
        print(f"Architecture Plan Summary:\n{plan.summary}")

        # Step 4: Generate each file individually at HIGH thinking so output never truncates
        generated_context = ""
        for step in plan.steps[:6]:
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
            gen_file: GeneratedFile = call_high_thinking_structured(client, file_prompt, GeneratedFile)
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

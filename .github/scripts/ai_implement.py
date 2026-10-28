import os
import pathlib
from typing import List
from pydantic import BaseModel, Field
from google import genai
from google.genai import types

# Schema guaranteeing clean, complete file writes
class FileChange(BaseModel):
    filepath: str = Field(description="Relative path from repo root, e.g., bot/strategy/fastSrConfluence.ts")
    explanation: str = Field(description="Brief explanation of what was created or modified in this file")
    content: str = Field(description="Complete, valid, production-ready source code for the entire file")

class ImplementationPlan(BaseModel):
    summary: str = Field(description="High-level architectural summary of the changes")
    files: List[FileChange] = Field(description="List of files to create or overwrite")

class RelevantFilesSelection(BaseModel):
    filepaths: List[str] = Field(description="List of existing repository filepaths relevant to the task")

IGNORE_DIRS = {".git", "node_modules", "dist", "build", ".next", "__pycache__", ".github"}
ALLOWED_EXTENSIONS = {".ts", ".tsx", ".js", ".json", ".py"}

def get_repo_tree() -> List[str]:
    file_list = []
    for root, dirs, files in os.walk("."):
        dirs[:] = [d for d in dirs if d not in IGNORE_DIRS]
        for f in files:
            ext = pathlib.Path(f).suffix
            if ext in ALLOWED_EXTENSIONS:
                rel_path = os.path.relpath(os.path.join(root, f), ".")
                file_list.append(rel_path)
    return sorted(file_list)

def read_files(filepaths: List[str], max_chars_per_file: int = 35000) -> str:
    bundled = []
    for fp in filepaths:
        if os.path.exists(fp) and os.path.isfile(fp):
            with open(fp, "r", encoding="utf-8", errors="replace") as f:
                content = f.read()[:max_chars_per_file]
                bundled.append(f"=== FILE: {fp} ===\n{content}\n=== END FILE: {fp} ===")
    return "\n\n".join(bundled)

def main():
    api_key = os.environ.get("GEMINI_API_KEY")
    if not api_key:
        raise RuntimeError("GEMINI_API_KEY secret is missing.")

    raw_task = os.environ.get("TASK_PROMPT", "").replace("/gemini-implement", "").strip()
    client = genai.Client(api_key=api_key)

    # 1. Gather repository tree
    repo_tree = get_repo_tree()
    print(f"Found {len(repo_tree)} source files in repository.")

    # 2. Tier 1 (Gemini 2.5 Flash): Identify which existing files to inspect and wire into
    flash_selector_prompt = (
        f"Repository file tree:\n" + "\n".join(repo_tree) + "\n\n"
        f"Task Request:\n{raw_task}\n\n"
        "Select up to 10 existing files from the repository tree that need to be read or modified "
        "to understand the interfaces and implement this task (such as main.ts, oms.ts, kalshiService.ts, package.json, tsconfig.json, etc.)."
    )

    selection_resp = client.models.generate_content(
        model="gemini-2.5-flash",
        contents=flash_selector_prompt,
        config=types.GenerateContentConfig(
            response_mime_type="application/json",
            response_schema=RelevantFilesSelection,
        ),
    )
    selected_files = selection_resp.parsed.filepaths
    print(f"Flash selected existing files for context: {selected_files}")

    codebase_context = read_files(selected_files)

    # 3. Tier 1 (Gemini 2.5 Flash): Summarize existing interfaces & architecture
    flash_map_prompt = (
        "Summarize the TypeScript interfaces, class signatures, order execution methods, and imports "
        "in these existing files so our lead architect model can wire new modules in without breaking types:\n\n"
        + codebase_context
    )
    arch_summary = client.models.generate_content(
        model="gemini-2.5-flash",
        contents=flash_map_prompt
    ).text

    # 4. Tier 2 (Gemini 2.5 Pro - High Thinking): Generate and wire full files
    reference_spec = """
Required Architecture Specifications to Implement & Wire In:
1. Fast Spot S/R & Volume Profile Engine:
   - O(N) sliding window extrema + 1D ATR histogram binning (0.5 * ATR bins).
   - Incremental Volume Profile returning Point of Control (POC), High Volume Nodes (HVN), and Low Volume Nodes (LVN).
   - Dynamic Ichimoku Kijun-sen (26) and Senkou Span B (52) equilibrium levels.
2. Kalshi Strike Shield & 80/20 Core + Runner Selector:
   - Reciprocal Kalshi order book parser: Implied YES Ask = 1.00 - Best NO Bid; Implied NO Ask = 1.00 - Best YES Bid.
   - Filters for strikes shielded behind the active spot S/R zone (below support for YES bounce, above resistance for NO rejection).
   - Quadratic taker fee formula: ceil(0.07 * contracts * price * (1 - price) * 100) / 100.
   - 80/20 Core + Runner split sized to achieve $4.50 net profit on the 80% Core scalp (+12c target) while capping total contracts at top-of-book ask depth.
3. Async Execution State Machine (FSM):
   - States: IDLE -> PLACING_ENTRY -> WAITING_FOR_FILL -> MANAGING_POSITION -> COMPLETED / CANCELED.
   - Immediately posts resting Maker (post_only) take-profit order for 80% Core contracts on entry fill.
   - Arms breakeven stop on the 20% Runner once the 80% Core TP fills.
   - Uses Promise.allSettled for parallel order cancellations in OMS.
"""

    pro_prompt = (
        "You are a Principal Quant Architect modifying a production TypeScript trading bot repository.\n"
        f"User Task:\n{raw_task}\n\n"
        f"{reference_spec}\n\n"
        f"Flash Architectural & Interface Map:\n{arch_summary}\n\n"
        f"Existing Source Files:\n{codebase_context}\n\n"
        "Instructions:\n"
        "- Create the new modular TypeScript files AND update the existing service/OMS/main files to wire them in.\n"
        "- Ensure every modified existing file preserves all existing functionality, exports, and strict TypeScript types.\n"
        "- Return the COMPLETE file content for every file you create or modify (never use '// ... existing code ...' placeholders)."
    )

    print("Running deep implementation with Gemini 2.5 Pro (High Thinking)...")
    pro_resp = client.models.generate_content(
        model="gemini-2.5-pro",
        contents=pro_prompt,
        config=types.GenerateContentConfig(
            thinking_config=types.ThinkingConfig(thinking_level="HIGH"),
            response_mime_type="application/json",
            response_schema=ImplementationPlan,
        ),
    )

    plan: ImplementationPlan = pro_resp.parsed
    print(f"Implementation Summary:\n{plan.summary}")

    # 5. Write generated files to disk for the PR action to commit
    for file_change in plan.files:
        target_path = pathlib.Path(file_change.filepath)
        target_path.parent.mkdir(parents=True, exist_ok=True)
        with open(target_path, "w", encoding="utf-8") as f:
            f.write(file_change.content)
        print(f"Wrote file: {file_change.filepath} ({file_change.explanation})")

if __name__ == "__main__":
    main()
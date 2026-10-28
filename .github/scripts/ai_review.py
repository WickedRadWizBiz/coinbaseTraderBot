import os
import time
import random
import subprocess
import requests
import traceback
from google import genai
from google.genai import types

UNAVAILABLE_MODELS = set()


def get_pr_diff() -> str:
    base_sha = os.environ.get("PR_BASE_SHA")
    head_sha = os.environ.get("PR_HEAD_SHA")
    cmd = ["git", "diff", f"{base_sha}...{head_sha}"] if (base_sha and head_sha) else ["git", "diff", "HEAD^", "HEAD"]
    result = subprocess.run(cmd, capture_output=True, text=True)
    return result.stdout


def post_github_comment(body: str):
    token = os.environ.get("GITHUB_TOKEN")
    repo = os.environ.get("REPOSITORY")
    pr_number = os.environ.get("PR_NUMBER")
    if not all([token, repo, pr_number]):
        print("Missing GitHub environment variables for commenting.")
        return

    url = f"https://api.github.com/repos/{repo}/issues/{pr_number}/comments"
    headers = {
        "Authorization": f"Bearer {token}",
        "Accept": "application/vnd.github+json",
    }
    response = requests.post(url, json={"body": body}, headers=headers)
    print(f"Posted comment status: {response.status_code}")


def generate_text_with_retry(
    client: genai.Client,
    prompt: str,
    thinking_level: str = "low",
    prefer_argon: bool = False,
    max_retries: int = 6,
) -> tuple[str, str]:
    candidate_models = ["gemini-4-argon", "gemini-3.8-flash"] if prefer_argon else ["gemini-3.8-flash"]
    candidate_models = [m for m in candidate_models if m not in UNAVAILABLE_MODELS]

    for model_name in candidate_models:
        for attempt in range(1, max_retries + 1):
            active_thinking = "medium" if (thinking_level == "high" and attempt >= 5) else thinking_level
            token_cap = 16384 if active_thinking == "medium" else 32768

            try:
                print(f"[{model_name}] Attempt {attempt}/{max_retries} (thinking={active_thinking})...")
                resp = client.models.generate_content(
                    model=model_name,
                    contents=prompt,
                    config=types.GenerateContentConfig(
                        max_output_tokens=token_cap,
                        thinking_config=types.ThinkingConfig(thinking_level=active_thinking),
                    ),
                )
                return resp.text, f"{model_name} ({active_thinking.capitalize()} Thinking)"

            except Exception as err:
                err_str = str(err).upper()
                if any(code in err_str for code in ("404", "NOT_FOUND", "403", "PERMISSION_DENIED")):
                    print(f"Model {model_name} unavailable on this key tier. Switching to fallback...")
                    UNAVAILABLE_MODELS.add(model_name)
                    break

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
                    break
                raise

    raise RuntimeError("All model attempts and retries exhausted.")


def main():
    try:
        api_key = os.environ.get("GEMINI_API_KEY")
        if not api_key:
            raise RuntimeError("GEMINI_API_KEY secret not found in GitHub Actions.")

        client = genai.Client(api_key=api_key)
        diff = get_pr_diff()
        if not diff.strip():
            print("No diff found to review. Exiting.")
            return

        print("Step 1: Parsing diff with gemini-3.8-flash (thinking_level=low)...")
        flash_prompt = (
            "Analyze the following git diff. Extract, parse, and categorize the changes. "
            "Filter out routine boilerplate formatting updates and cleanly summarize the core "
            "algorithmic, state machine, and trading logic changes:\n\n" + diff[:25000]
        )
        parsed_summary, _ = generate_text_with_retry(
            client, flash_prompt, thinking_level="low", prefer_argon=False
        )

        print("Step 2: Conducting deep code vetting...")
        deep_prompt = (
            "You are a rigorous Principal Software Engineer and Quant Developer reviewing a high-stakes algorithmic trading bot. "
            "Perform an exhaustive technical review focusing heavily on:\n"
            "1. Concurrency and async state machine (FSM) edge cases, potential race conditions, or unhandled exceptions.\n"
            "2. Financial math accuracy (Kalshi quadratic fee bounds, rounding edge cases, capital exposure limits).\n"
            "3. L2 order book parsing consistency and slippage boundaries.\n\n"
            f"Parsed Logic Summary:\n{parsed_summary}\n\n"
            f"Raw Code Changes (Diff):\n{diff[:20000]}"
        )
        review_output, model_used = generate_text_with_retry(
            client, deep_prompt, thinking_level="high", prefer_argon=True
        )

        final_comment = (
            "### 🤖 Gemini Architecture & Code Review\n\n"
            f"{review_output}\n\n"
            f"---\n*Parsing powered by `gemini-3.8-flash` (Low Thinking) | Deep vetting powered by `{model_used}`*"
        )
        post_github_comment(final_comment)

    except Exception:
        print("An error occurred during the AI review pipeline:")
        traceback.print_exc()
        exit(1)


if __name__ == "__main__":
    main()

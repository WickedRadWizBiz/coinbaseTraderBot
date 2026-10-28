import os
import subprocess
import requests
import traceback
from google import genai
from google.genai import types

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
        "Accept": "application/vnd.github+json"
    }
    response = requests.post(url, json={"body": body}, headers=headers)
    print(f"Posted comment status: {response.status_code}")

def generate_deep_review(client: genai.Client, prompt: str) -> tuple[str, str]:
    """
    Attempts Gemini 4 Argon at HIGH thinking first; falls back to Gemini 3.8 Flash at HIGH thinking
    if the API key tier only permits gemini-3.8-flash.
    """
    high_thinking_cfg = types.GenerateContentConfig(
        max_output_tokens=65536,
        thinking_config=types.ThinkingConfig(thinking_level="high")
    )
    try:
        print("Attempting Tier 2 review with gemini-4-argon (thinking_level=high)...")
        resp = client.models.generate_content(
            model="gemini-4-argon",
            contents=prompt,
            config=high_thinking_cfg
        )
        return resp.text, "gemini-4-argon (High Thinking)"
    except Exception as err:
        print(f"gemini-4-argon unavailable on this key ({err}). Using gemini-3.8-flash (thinking_level=high)...")
        resp = client.models.generate_content(
            model="gemini-3.8-flash",
            contents=prompt,
            config=high_thinking_cfg
        )
        return resp.text, "gemini-3.8-flash (High Thinking)"

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

        flash_response = client.models.generate_content(
            model="gemini-3.8-flash",
            contents=flash_prompt,
            config=types.GenerateContentConfig(
                thinking_config=types.ThinkingConfig(thinking_level="low")
            )
        )
        parsed_summary = flash_response.text

        print("Step 2: Conducting deep code vetting at High thinking level...")
        deep_prompt = (
            "You are a rigorous Principal Software Engineer and Quant Developer reviewing a high-stakes algorithmic trading bot. "
            "Perform an exhaustive technical review focusing heavily on:\n"
            "1. Concurrency and async state machine (FSM) edge cases, potential race conditions, or unhandled exceptions.\n"
            "2. Financial math accuracy (Kalshi quadratic fee bounds, rounding edge cases, capital exposure limits).\n"
            "3. L2 order book parsing consistency and slippage boundaries.\n\n"
            f"Parsed Logic Summary:\n{parsed_summary}\n\n"
            f"Raw Code Changes (Diff):\n{diff[:20000]}"
        )

        review_output, model_used = generate_deep_review(client, deep_prompt)

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

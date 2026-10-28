import os
import subprocess
import requests
from google import genai
from google.genai import types

def get_pr_diff():
    result = subprocess.run(["git", "diff", "HEAD^", "HEAD"], capture_output=True, text=True)
    return result.stdout

def post_github_comment(body):
    token = os.environ.get("GITHUB_TOKEN")
    repo = os.environ.get("REPOSITORY")
    pr_number = os.environ.get("PR_NUMBER")
    
    url = f"https://api.github.com/repos/{repo}/issues/{pr_number}/comments"
    headers = {
        "Authorization": f"Bearer {token}",
        "Accept": "application/vnd.github+json"
    }
    response = requests.post(url, json={"body": body}, headers=headers)
    print(f"Posted comment status: {response.status_code}")

def main():
    api_key = os.environ.get("GEMINI_API_KEY")
    if not api_key:
        print("Error: GEMINI_API_KEY not found.")
        return

    client = genai.Client(api_key=api_key)
    diff = get_pr_diff()
    if not diff.strip():
        print("No diff found to review.")
        return

    print("Step 1: Parsing and summarizing diff with Gemini 2.5 Flash...")
    flash_prompt = (
        "Analyze the following git diff. Extract, parse, and categorize the changes. "
        "Filter out routine boilerplate formatting updates and cleanly summarize the core "
        "algorithmic, state machine, and trading logic changes:\n\n" + diff[:15000]
    )
    
    flash_response = client.models.generate_content(
        model="gemini-2.5-flash",
        contents=flash_prompt
    )
    parsed_summary = flash_response.text
    print("Flash summary completed.")

    print("Step 2: Conducting deep code vetting with Gemini 4 Argon (High Thinking)...")
    argon_prompt = (
        "You are a rigorous Principal Software Engineer and Quant Developer reviewing a high-stakes algorithmic trading bot. "
        "Perform an exhaustive technical review focusing heavily on:\n"
        "1. Concurrency and async state machine (FSM) edge cases, potential race conditions, or unhandled exceptions.\n"
        "2. Financial math accuracy (Kalshi quadratic fee bounds, rounding edge cases, capital exposure limits).\n"
        "3. L2 order book parsing consistency and slippage boundaries.\n\n"
        f"Parsed Logic Summary:\n{parsed_summary}\n\n"
        f"Raw Code Changes (Diff):\n{diff[:10000]}"
    )

    # Call Gemini 4 Argon with High thinking depth enabled
    argon_response = client.models.generate_content(
        model="gemini-4-argon",
        contents=argon_prompt,
        config=types.GenerateContentConfig(
            thinking_config=types.ThinkingConfig(thinking_level="high")
        )
    )
    
    review_output = argon_response.text
    
    final_comment = (
        "### 🤖 Gemini Architecture & Code Review\n\n"
        f"{review_output}\n\n"
        "---\n*Parsing powered by `gemini-2.5-flash` | Deep architectural vetting powered by `gemini-4-argon` (High Thinking)*"
    )
    
    post_github_comment(final_comment)

if __name__ == "__main__":
    main()
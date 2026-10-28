import os
import subprocess
import requests
import traceback
from google import genai
from google.genai import types

def get_pr_diff():
    # Use the base and head SHAs provided by GitHub Actions environment variables for a reliable diff
    base_sha = os.environ.get("PR_BASE_SHA")
    head_sha = os.environ.get("PR_HEAD_SHA")
    
    if base_sha and head_sha:
        cmd = ["git", "diff", f"{base_sha}...{head_sha}"]
    else:
        # Fallback to local HEAD comparison if env vars aren't present
        cmd = ["git", "diff", "HEAD^", "HEAD"]
        
    result = subprocess.run(cmd, capture_output=True, text=True)
    return result.stdout

def post_github_comment(body):
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

def main():
    try:
        api_key = os.environ.get("GEMINI_API_KEY")
        if not api_key:
            print("Error: GEMINI_API_KEY secret not found in GitHub Actions.")
            return

        client = genai.Client(api_key=api_key)
        diff = get_pr_diff()
        
        if not diff.strip():
            print("No diff found to review. Exiting successfully.")
            return

        print(f"Captured diff length: {len(diff)} characters.")

        print("Step 1: Parsing diff with Gemini 2.5 Flash...")
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
        print("Flash summary completed successfully.")

        print("Step 2: Conducting deep code vetting...")
        argon_prompt = (
            "You are a rigorous Principal Software Engineer and Quant Developer reviewing a high-stakes algorithmic trading bot. "
            "Perform an exhaustive technical review focusing heavily on:\n"
            "1. Concurrency and async state machine (FSM) edge cases, potential race conditions, or unhandled exceptions.\n"
            "2. Financial math accuracy (Kalshi quadratic fee bounds, rounding edge cases, capital exposure limits).\n"
            "3. L2 order book parsing consistency and slippage boundaries.\n\n"
            f"Parsed Logic Summary:\n{parsed_summary}\n\n"
            f"Raw Code Changes (Diff):\n{diff[:10000]}"
        )

        # Using gemini-2.5-pro for deep architectural and financial vetting
        argon_response = client.models.generate_content(
            model="gemini-2.5-pro",
            contents=argon_prompt,
        )
        
        review_output = argon_response.text
        
        final_comment = (
            "### 🤖 Gemini Architecture & Code Review\n\n"
            f"{review_output}\n\n"
            "---\n*Parsing powered by `gemini-2.5-flash` | Deep architectural vetting powered by `gemini-2.5-pro`*"
        )
        
        post_github_comment(final_comment)
        print("Review comment posted successfully to PR.")

    except Exception as e:
        print("An error occurred during the AI review pipeline:")
        traceback.print_exc()
        exit(1)

if __name__ == "__main__":
    main()
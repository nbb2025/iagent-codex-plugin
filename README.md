# iAgent Codex Plugin

Use the signed-in [iAgent Creative Studio](https://ai.iagent.dev/app/images) from Codex to generate images and videos, inspect available creative models, query task status, and stop running jobs.

## Install

```bash
codex plugin marketplace add nbb2025/iagent-codex-plugin --ref main
codex plugin add iagent@iagent
```

Start a new Codex conversation after installation, then try:

```text
Use iAgent to generate a 16:9, 2K product poster.
```

On the first tool call, Codex returns a loopback connection URL. Open it in the browser where you use iAgent. The local bridge connects automatically after you sign in and enter Creative Studio.

## Privacy

- The plugin and browser bridge run locally.
- The connection URL points to `127.0.0.1` and contains no token.
- The browser uses the iAgent API Key directly; the key is not returned to Codex or written into this repository.
- Generated results remain in the current browser's Creative Studio history.

## Update

```bash
codex plugin marketplace upgrade iagent
codex plugin add iagent@iagent
```

Start a new Codex conversation after updating so the latest tools and skill instructions are loaded.

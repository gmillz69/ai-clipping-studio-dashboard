# AI Clipping Studio — dashboard

Static, public web dashboard for a **private** AI Clipping Studio backend that runs
on a free Kaggle GPU. It contains **no credentials**: you connect it to your own
backend's tunnel URL and sign in with the administrator account configured in
your Kaggle Secrets. Sessions are short-lived and kept only in the browser tab.

- No backend running? The dashboard still loads and shows the connection status.
- Clip previews and downloads use short-lived signed links issued by the backend.

Based on the Clipping Studio of [OpenSource Clipping](https://github.com/NaufalRizqullah/opensource-clipping)
(MIT licence, © 2026 Muhammad Naufal Rizqullah). See `LICENSE`.

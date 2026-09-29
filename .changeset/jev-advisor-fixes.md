---
"frontier-proxy": patch
---

Jev routing advisor fixes: tasks now show the model an agent actually ran (the advisor's pick or your override) instead of the provider's default when the CLI doesn't report its model; long pasted logs and non-English prompts get Jev advice instead of silently falling back to local rules; and Jev errors read as a plain sentence instead of raw JSON.

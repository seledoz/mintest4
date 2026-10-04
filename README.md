## Public repository

Use this loader in the game console:

```js
(async () => {
  try {
    const url = "https://raw.githubusercontent.com/seledoz/mintest4/main/pz-bot.js?t=" + Date.now() + "-" + Math.random();
    console.log("[minibia-bot] Fetching pz-bot.js:", url);

    const response = await fetch(url, { cache: "no-store" });
    if (!response.ok) throw new Error(`HTTP ${response.status} ${response.statusText}`);

    const code = await response.text();
    console.log("[minibia-bot] Received pz-bot.js:", {
      bytes: code.length,
      hasErrorDeclaration: code.includes("let error=evaluate(code);")
    });

    if (!code.trim()) throw new Error("GitHub returned an empty pz-bot.js");
    new Function(code);

    console.log("[minibia-bot] Executing pz-bot.js through Function boundary...");
    new Function(code)();
  } catch (error) {
    console.error("[minibia-bot] README loader failed:", error);
  }
})();
```

## Private repository

Use a fine-grained GitHub token with read and write access to the repository contents.

```js
(async () => {
  const token = prompt("Paste your GitHub token:")?.trim();
  if (!token) return;

  const repository = "seledoz/mintest4";
  const ref = "main";
  const rawPrefix = `https://raw.githubusercontent.com/${repository}/${ref}/`;
  const apiPrefix = `https://api.github.com/repos/${repository}/contents`;
  const originalFetch = window.fetch.bind(window);

  function githubHeaders(existingHeaders, accept = "application/vnd.github+json") {
    const headers = new Headers(existingHeaders || {});
    headers.set("Authorization", `Bearer ${token}`);
    headers.set("Accept", accept);
    headers.set("X-GitHub-Api-Version", "2022-11-28");
    return headers;
  }

  function rawToApi(url) {
    const path = url.slice(rawPrefix.length).split("?")[0];
    return `${apiPrefix}/${path}?ref=${encodeURIComponent(ref)}&t=${Date.now()}`;
  }

  window.fetch = function authenticatedPrivateRepoFetch(input, init = {}) {
    const url = typeof input === "string" ? input : input?.url;
    if (!url) return originalFetch(input, init);

    let nextUrl = url;
    let accept = "application/vnd.github+json";

    if (url.startsWith(rawPrefix)) {
      nextUrl = rawToApi(url);
      accept = "application/vnd.github.raw+json";
    } else if (!url.startsWith(apiPrefix)) {
      return originalFetch(input, init);
    }

    return originalFetch(nextUrl, {
      ...init,
      headers: githubHeaders(init.headers, accept),
      cache: "no-store",
    });
  };

  const response = await originalFetch(
    `${apiPrefix}/pz-bot.js?ref=${encodeURIComponent(ref)}&t=${Date.now()}-${Math.random()}`,
    {
      headers: githubHeaders(undefined, "application/vnd.github.raw+json"),
      cache: "no-store",
    }
  );

  if (!response.ok) {
    throw new Error(`GitHub fetch failed: ${response.status} ${response.statusText}`);
  }

  const code = await response.text();
  if (!code.trim()) throw new Error("GitHub returned an empty pz-bot.js");
  new Function(code);
  window.eval(code);
})().catch((error) => {
  console.error("[minibia-bot] Private README loader failed:", error);
});
```

## Private repository

Use a fine-grained GitHub token with read and write access to the repository contents.

```js
(async () => {
  const token = prompt("Paste your GitHub token:")?.trim();
  if (!token) return;

  const repository = "seledoz/mintest4";
  const ref = "main";
  const rawPrefix = `https://raw.githubusercontent.com/${repository}/${ref}/`;
  const apiPrefix = `https://api.github.com/repos/${repository}/contents`;
  const originalFetch = window.fetch.bind(window);

  function githubHeaders(existingHeaders, accept = "application/vnd.github+json") {
    const headers = new Headers(existingHeaders || {});
    headers.set("Authorization", `Bearer ${token}`);
    headers.set("Accept", accept);
    headers.set("X-GitHub-Api-Version", "2022-11-28");
    return headers;
  }

  function rawToApi(url) {
    const path = url.slice(rawPrefix.length).split("?")[0];
    return `${apiPrefix}/${path}?ref=${encodeURIComponent(ref)}&t=${Date.now()}`;
  }

  // Authenticate mintest4 GitHub requests.
  window.fetch = function authenticatedPrivateRepoFetch(input, init = {}) {
    const url = typeof input === "string" ? input : input?.url;
    if (!url) return originalFetch(input, init);

    let nextUrl = url;
    let accept = "application/vnd.github+json";

    if (url.startsWith(rawPrefix)) {
      nextUrl = rawToApi(url);
      accept = "application/vnd.github.raw+json";
    } else if (!url.startsWith(apiPrefix)) {
      return originalFetch(input, init);
    }

    return originalFetch(nextUrl, {
      ...init,
      headers: githubHeaders(init.headers, accept),
      cache: "no-store",
    });
  };

  const response = await originalFetch(
    `${apiPrefix}/pz-bot.js?ref=${encodeURIComponent(ref)}&t=${Date.now()}`,
    {
      headers: githubHeaders(undefined, "application/vnd.github.raw+json"),
      cache: "no-store",
    }
  );

  if (!response.ok) {
    throw new Error(`GitHub fetch failed: ${response.status} ${response.statusText}`);
  }

  window.eval(await response.text());
})();
```

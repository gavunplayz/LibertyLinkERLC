const SITE_URL = "https://gavunplayz.github.io/LibertyLinkERLC";

function corsHeaders(origin) {
  return {
    "Access-Control-Allow-Origin": SITE_URL,
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
    "Access-Control-Allow-Credentials": "true",
    "Vary": "Origin"
  };
}

function json(data, status = 200, origin = "") {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json", ...corsHeaders(origin) }
  });
}

function base64url(bytes) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function encodeText(value) {
  return base64url(new TextEncoder().encode(value));
}

async function sign(payload, secret) {
  const header = encodeText(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const body = encodeText(JSON.stringify(payload));
  const data = header + "." + body;
  const key = await crypto.subtle.importKey(
    "raw", new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" }, false, ["sign"]
  );
  const signature = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(data));
  return data + "." + base64url(new Uint8Array(signature));
}

async function verify(token, secret) {
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const data = parts[0] + "." + parts[1];
  const key = await crypto.subtle.importKey(
    "raw", new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" }, false, ["verify"]
  );
  const signature = Uint8Array.from(atob(parts[2].replace(/-/g, "+").replace(/_/g, "/") + "==".slice((parts[2].length + 2) % 4)), c => c.charCodeAt(0));
  const valid = await crypto.subtle.verify("HMAC", key, signature, new TextEncoder().encode(data));
  if (!valid) return null;
  const payload = JSON.parse(atob(parts[1].replace(/-/g, "+").replace(/_/g, "/") + "==".slice((parts[1].length + 2) % 4)));
  if (!payload.exp || payload.exp < Math.floor(Date.now() / 1000)) return null;
  return payload;
}

function getCookie(request, name) {
  const cookie = request.headers.get("Cookie") || "";
  const match = cookie.match(new RegExp("(?:^|; )" + name + "=([^;]*)"));
  return match ? match[1] : "";
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const origin = request.headers.get("Origin") || "";

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders(origin) });
    }

    if (url.pathname === "/login") {
      const stateBytes = crypto.getRandomValues(new Uint8Array(32));
      const state = base64url(stateBytes);
      const redirectUri = url.origin + "/callback";
      const authorize = new URL("https://discord.com/oauth2/authorize");
      authorize.search = new URLSearchParams({
        client_id: env.DISCORD_CLIENT_ID,
        response_type: "code",
        redirect_uri: redirectUri,
        scope: "identify",
        state
      }).toString();

      return new Response(null, {
        status: 302,
        headers: {
          "Location": authorize.toString(),
          "Set-Cookie": "ll_oauth_state=" + state + "; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=600"
        }
      });
    }

    if (url.pathname === "/callback") {
      const code = url.searchParams.get("code");
      const returnedState = url.searchParams.get("state");
      const savedState = getCookie(request, "ll_oauth_state");
      const clearState = "ll_oauth_state=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0";

      if (!code || !returnedState || !savedState || returnedState !== savedState) {
        return new Response("Discord sign-in could not be verified. Please return to Liberty Link and try again.", { status: 400, headers: { "Set-Cookie": clearState } });
      }

      const redirectUri = url.origin + "/callback";
      const tokenResponse = await fetch("https://discord.com/api/oauth2/token", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          client_id: env.DISCORD_CLIENT_ID,
          client_secret: env.DISCORD_CLIENT_SECRET,
          grant_type: "authorization_code",
          code,
          redirect_uri: redirectUri
        })
      });

      if (!tokenResponse.ok) {
        return new Response("Discord token exchange failed. Please try signing in again.", { status: 502, headers: { "Set-Cookie": clearState } });
      }

      const tokenData = await tokenResponse.json();
      const userResponse = await fetch("https://discord.com/api/users/@me", {
        headers: { Authorization: "Bearer " + tokenData.access_token }
      });

      if (!userResponse.ok) {
        return new Response("Could not retrieve your Discord account. Please try again.", { status: 502, headers: { "Set-Cookie": clearState } });
      }

      const user = await userResponse.json();
      const session = await sign({
        sub: user.id,
        username: user.username,
        global_name: user.global_name || user.username,
        avatar: user.avatar || null,
        exp: Math.floor(Date.now() / 1000) + 60 * 60 * 24 * 7
      }, env.SESSION_SECRET);

      return new Response(null, {
        status: 302,
        headers: {
          "Location": SITE_URL + "/#session=" + encodeURIComponent(session),
          "Set-Cookie": clearState
        }
      });
    }

    if (url.pathname === "/me") {
      if (origin !== SITE_URL) return json({ error: "Origin not allowed" }, 403, origin);
      const authorization = request.headers.get("Authorization") || "";
      const token = authorization.startsWith("Bearer ") ? authorization.slice(7) : "";
      const user = token ? await verify(token, env.SESSION_SECRET) : null;
      if (!user) return json({ error: "Not signed in" }, 401, origin);
      return json({
        id: user.sub,
        username: user.username,
        global_name: user.global_name,
        avatar: user.avatar
      }, 200, origin);
    }

    return new Response("Liberty Link authentication service", {
      headers: { "Content-Type": "text/plain" }
    });
  }
};

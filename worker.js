const SITE_URL = "https://gavunplayz.github.io/LibertyLinkERLC";
const SITE_ORIGIN = "https://gavunplayz.github.io";

function corsHeaders(origin) {
  return {
    "Access-Control-Allow-Origin": origin === SITE_ORIGIN ? SITE_ORIGIN : SITE_ORIGIN,
    "Access-Control-Allow-Methods": "GET, POST, PATCH, OPTIONS",
    "Access-Control-Allow-Headers": "Authorization, Content-Type",
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

function decodeText(value) {
  const base64 = value.replace(/-/g, "+").replace(/_/g, "/") + "==".slice((value.length + 2) % 4);
  const binary = atob(base64);
  const bytes = Uint8Array.from(binary, char => char.charCodeAt(0));
  return new TextDecoder().decode(bytes);
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
  const payload = JSON.parse(decodeText(parts[1]));
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
      if (!env.DISCORD_CLIENT_ID || !env.DISCORD_CLIENT_SECRET || !env.SESSION_SECRET) {
        return new Response("Authentication is not configured yet. Please add the required Worker secrets.", { status: 500 });
      }
      const state = base64url(crypto.getRandomValues(new Uint8Array(32)));
      const redirectUri = url.origin + "/callback";
      const authorize = new URL("https://discord.com/oauth2/authorize");
      authorize.search = new URLSearchParams({
        client_id: env.DISCORD_CLIENT_ID,
        response_type: "code",
        redirect_uri: redirectUri,
        scope: "identify guilds",
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

      if (url.searchParams.has("error")) {
        return new Response("Discord sign-in was cancelled. You can close this page and try again.", { status: 400, headers: { "Set-Cookie": clearState } });
      }
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
      const guildResponse = await fetch("https://discord.com/api/users/@me/guilds", {
        headers: { Authorization: "Bearer " + tokenData.access_token }
      });
      if (!guildResponse.ok) {
        return new Response("Could not retrieve your Discord servers. Please authorize again.", { status: 502, headers: { "Set-Cookie": clearState } });
      }
      const discordGuilds = await guildResponse.json();
      const manageableGuilds = discordGuilds
        .filter(guild => guild.owner || (BigInt(guild.permissions || "0") & 32n) === 32n)
        .map(guild => ({ id: guild.id, name: guild.name, icon: guild.icon || null }));
      const session = await sign({
        sub: user.id,
        username: user.username,
        global_name: user.global_name || user.username,
        avatar: user.avatar || null,
        guilds: manageableGuilds,
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

    if (url.pathname.startsWith("/api/")) {
      if (url.pathname.startsWith("/api/public/") && request.method === "GET") {
        if (!env.DB) return json({ error: "Server database is not connected." }, 503, origin);
        const serverId = url.pathname.split("/").pop();
        const server = await env.DB.prepare(
          "SELECT id, name, discord_guild_name, status, staff_count, description, announcement, created_at FROM servers WHERE id = ?"
        ).bind(serverId).first();
        if (!server) return json({ error: "Server not found." }, 404, origin);
        return json({ server }, 200, origin);
      }
      const authorization = request.headers.get("Authorization") || "";
      const token = authorization.startsWith("Bearer ") ? authorization.slice(7) : "";
      let user;
      try { user = token ? await verify(token, env.SESSION_SECRET) : null; }
      catch { user = null; }
      if (!user) return json({ error: "Please sign in again." }, 401, origin);
      if (!env.DB) return json({ error: "Server database is not connected yet. Please try again after setup." }, 503, origin);


      const staffMatch = url.pathname.match(/^\/api\/staff\/([a-f0-9-]+)$/i);
      if (staffMatch) {
        const serverId = staffMatch[1];
        const membership = await env.DB.prepare(
          "SELECT m.role, s.id, s.name, s.status, s.staff_count, s.description, s.announcement, s.discord_guild_name FROM memberships m JOIN servers s ON s.id = m.server_id WHERE m.server_id = ? AND m.user_id = ?"
        ).bind(serverId, user.sub).first();
        if (!membership || !["owner", "staff"].includes(membership.role)) {
          return json({ error: "You need server staff permissions to access this page." }, 403, origin);
        }
        if (request.method === "GET") return json({ server: membership }, 200, origin);
        if (request.method === "PATCH") {
          let body;
          try { body = await request.json(); } catch { return json({ error: "Invalid request body." }, 400, origin); }
          const status = String(body.status || "").toLowerCase();
          const staffCount = Number(body.staff_count);
          const description = String(body.description || "").trim().slice(0, 500);
          const announcement = String(body.announcement || "").trim().slice(0, 300);
          if (!["online", "offline"].includes(status)) return json({ error: "Choose online or offline status." }, 400, origin);
          if (!Number.isInteger(staffCount) || staffCount < 0 || staffCount > 100000) return json({ error: "Staff count must be a whole number from 0 to 100000." }, 400, origin);
          await env.DB.prepare(
            "UPDATE servers SET status = ?, staff_count = ?, description = ?, announcement = ? WHERE id = ?"
          ).bind(status, staffCount, description, announcement, serverId).run();
          return json({ success: true }, 200, origin);
        }
      }

      if (url.pathname === "/api/guilds" && request.method === "GET") {
        return json({ guilds: user.guilds || [] }, 200, origin);
      }

      if (url.pathname === "/api/servers" && request.method === "GET") {
        const rows = await env.DB.prepare(
          "SELECT s.id, s.name, s.join_code, s.discord_guild_id, s.discord_guild_name, s.created_at, m.role FROM memberships m JOIN servers s ON s.id = m.server_id WHERE m.user_id = ? ORDER BY s.created_at DESC"
        ).bind(user.sub).all();
        return json({ servers: rows.results || [] }, 200, origin);
      }

      if (url.pathname === "/api/servers" && request.method === "POST") {
        let body;
        try { body = await request.json(); } catch { return json({ error: "Invalid request body." }, 400, origin); }
        const name = String(body.name || "").trim().slice(0, 48);
        const guildId = String(body.discordGuildId || "");
        if (name.length < 2) return json({ error: "Server name must be at least 2 characters." }, 400, origin);
        const guild = (user.guilds || []).find(item => item.id === guildId);
        if (!guild) return json({ error: "Choose a Discord server where you have Manage Server or Administrator permission. Sign in again to refresh your server list." }, 403, origin);
        const id = crypto.randomUUID();
        const codeChars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
        const random = crypto.getRandomValues(new Uint8Array(8));
        const code = Array.from(random, n => codeChars[n % codeChars.length]).join("");
        try {
          await env.DB.batch([
            env.DB.prepare("INSERT INTO servers (id, name, owner_user_id, discord_guild_id, discord_guild_name, join_code, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
              .bind(id, name, user.sub, guild.id, guild.name, code, new Date().toISOString()),
            env.DB.prepare("INSERT INTO memberships (server_id, user_id, role, joined_at) VALUES (?, ?, 'owner', ?)")
              .bind(id, user.sub, new Date().toISOString())
          ]);
        } catch (error) {
          return json({ error: "Could not create the server. Please try again." }, 500, origin);
        }
        return json({ server: { id, name, join_code: code, discord_guild_id: guild.id, discord_guild_name: guild.name, role: "owner" }, join_url: SITE_URL + "/?join=" + code }, 201, origin);
      }

      if (url.pathname === "/api/join" && request.method === "POST") {
        let body;
        try { body = await request.json(); } catch { return json({ error: "Invalid request body." }, 400, origin); }
        const code = String(body.code || "").trim().toUpperCase().replace(/[^A-Z0-9]/g, "");
        if (!code) return json({ error: "Enter a join code." }, 400, origin);
        const server = await env.DB.prepare("SELECT id, name, join_code, discord_guild_name FROM servers WHERE join_code = ?").bind(code).first();
        if (!server) return json({ error: "That join code was not found." }, 404, origin);
        await env.DB.prepare("INSERT OR IGNORE INTO memberships (server_id, user_id, role, joined_at) VALUES (?, ?, 'member', ?)")
          .bind(server.id, user.sub, new Date().toISOString()).run();
        return json({ server }, 200, origin);
      }
      return json({ error: "API route not found." }, 404, origin);
    }

    if (url.pathname === "/me") {
      if (origin !== SITE_ORIGIN) return json({ error: "Origin not allowed" }, 403, origin);
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

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


async function discordBotFetch(env, path) {
  if (!env.DISCORD_BOT_TOKEN) throw new Error("Discord bot token is not configured in the Worker.");
  const response = await fetch("https://discord.com/api/v10" + path, {
    headers: { Authorization: "Bot " + env.DISCORD_BOT_TOKEN }
  });
  if (!response.ok) {
    const detail = await response.text();
    throw new Error("Discord API " + response.status + ": " + detail.slice(0, 180));
  }
  return response.status === 204 ? null : response.json();
}

async function getDiscordMember(env, guildId, userId) {
  try {
    return await discordBotFetch(env, "/guilds/" + encodeURIComponent(guildId) + "/members/" + encodeURIComponent(userId));
  } catch (error) {
    if (String(error.message).includes("404")) return null;
    throw error;
  }
}

async function refreshDiscordCounts(env, server) {
  if (!env.DISCORD_BOT_TOKEN) return server;
  const synced = server.discord_synced_at ? Date.parse(server.discord_synced_at) : 0;
  if (synced && Date.now() - synced < 5 * 60 * 1000) return server;
  try {
    const guild = await discordBotFetch(env, "/guilds/" + encodeURIComponent(server.discord_guild_id) + "?with_counts=true");
    let staffCount = 0;
    if (server.staff_role_id) {
      let after = "0";
      while (true) {
        const members = await discordBotFetch(env, "/guilds/" + encodeURIComponent(server.discord_guild_id) + "/members?limit=1000&after=" + after);
        if (!Array.isArray(members) || members.length === 0) break;
        for (const member of members) {
          if (Array.isArray(member.roles) && member.roles.includes(server.staff_role_id)) staffCount++;
        }
        after = members[members.length - 1].user.id;
        if (members.length < 1000) break;
      }
    }
    const memberCount = Number(guild.approximate_member_count || 0);
    const syncedAt = new Date().toISOString();
    await env.DB.prepare("UPDATE servers SET staff_count = ?, discord_member_count = ?, discord_synced_at = ? WHERE id = ?")
      .bind(staffCount, memberCount, syncedAt, server.id).run();
    return { ...server, staff_count: staffCount, discord_member_count: memberCount, discord_synced_at: syncedAt };
  } catch (error) {
    console.error("Discord count sync failed:", error);
    return server;
  }
}


function hexToBytes(hex) {
  if (!/^[0-9a-f]+$/i.test(hex) || hex.length % 2 !== 0) throw new Error("Invalid hex value.");
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i++) bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return bytes;
}

async function verifyDiscordRequest(request, rawBody, publicKey) {
  const signature = request.headers.get("X-Signature-Ed25519") || "";
  const timestamp = request.headers.get("X-Signature-Timestamp") || "";
  if (!publicKey || !signature || !timestamp || !/^\\d+$/.test(timestamp)) return false;
  const seconds = Math.floor(Date.now() / 1000);
  if (Math.abs(seconds - Number(timestamp)) > 300) return false;
  try {
    const key = await crypto.subtle.importKey("raw", hexToBytes(publicKey), { name: "Ed25519" }, false, ["verify"]);
    return await crypto.subtle.verify("Ed25519", key, hexToBytes(signature), new TextEncoder().encode(timestamp + rawBody));
  } catch (error) {
    console.error("Discord signature verification failed:", error);
    return false;
  }
}

function discordReply(content) {
  return new Response(JSON.stringify({
    type: 4,
    data: { content, flags: 64 }
  }), { status: 200, headers: { "Content-Type": "application/json" } });
}

async function handleDiscordInteraction(request, env) {
  const rawBody = await request.text();
  if (!await verifyDiscordRequest(request, rawBody, env.DISCORD_PUBLIC_KEY)) {
    return new Response("Invalid Discord request signature.", { status: 401 });
  }

  let interaction;
  try { interaction = JSON.parse(rawBody); }
  catch { return new Response("Invalid JSON.", { status: 400 }); }

  if (interaction.type === 1) {
    return new Response(JSON.stringify({ type: 1 }), {
      headers: { "Content-Type": "application/json" }
    });
  }
  if (interaction.type !== 2) return discordReply("That interaction is not supported.");
  if (!env.DB) return discordReply("Liberty Link's database is unavailable right now.");

  const guildId = String(interaction.guild_id || "");
  const userId = String(interaction.member?.user?.id || interaction.user?.id || "");
  if (!guildId || !userId) return discordReply("Use Liberty Link commands inside your connected Discord server, not in direct messages.");

  const server = await env.DB.prepare(
    "SELECT id, name, owner_user_id, discord_guild_id, status, current_activity, staff_role_id, whitelisted_role_id FROM servers WHERE discord_guild_id = ?"
  ).bind(guildId).first();

  if (!server) return discordReply("This Discord server is not connected to a Liberty Link community.");

  const isOwner = server.owner_user_id === userId;
  const memberRoles = Array.isArray(interaction.member?.roles) ? interaction.member.roles : [];
  const isStaff = !!server.staff_role_id && memberRoles.includes(server.staff_role_id);
  if (!isOwner && !isStaff) {
    return discordReply("You do not have permission to use this command. You need the staff role selected by the community owner on the Liberty Link website.");
  }

  const command = interaction.data?.name;
  const options = interaction.data?.options || [];
  const option = options.find(item => item.name === "value" || item.name === "text");
  const now = new Date().toISOString();

  if (command === "status") {
    const status = String(option?.value || "").toLowerCase();
    if (!["online", "offline", "whitelisted"].includes(status)) {
      return discordReply("Choose Online, Offline, or Whitelisted.");
    }
    if (status === "whitelisted" && !server.whitelisted_role_id) {
      return discordReply("A whitelist role has not been selected on the Liberty Link website yet. Ask the community owner to configure it first.");
    }
    await env.DB.prepare("UPDATE servers SET status = ?, discord_synced_at = NULL WHERE id = ?")
      .bind(status, server.id).run();
    await env.DB.prepare(
      "INSERT INTO server_audit_log (server_id, actor_user_id, action, old_value, new_value, created_at) VALUES (?, ?, ?, ?, ?, ?)"
    ).bind(server.id, userId, "status", server.status || "", status, now).run();
    const label = status.charAt(0).toUpperCase() + status.slice(1);
    return discordReply(server.name + " status has been set to " + label + ".");
  }

  if (command === "activity") {
    const supplied = String(option?.value || "").trim();
    const activity = supplied.toLowerCase() === "clear" ? "" : supplied.slice(0, 100);
    if (!supplied) return discordReply("Enter an activity, or type CLEAR to remove the current activity.");
    await env.DB.prepare("UPDATE servers SET current_activity = ? WHERE id = ?")
      .bind(activity, server.id).run();
    await env.DB.prepare(
      "INSERT INTO server_audit_log (server_id, actor_user_id, action, old_value, new_value, created_at) VALUES (?, ?, ?, ?, ?, ?)"
    ).bind(server.id, userId, "activity", server.current_activity || "", activity, now).run();
    return discordReply(activity
      ? "Current activity updated to: " + activity
      : "The current activity has been cleared.");
  }

  return discordReply("Unknown Liberty Link command.");
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

    if (url.pathname === "/discord/interactions" && request.method === "POST") {
      return handleDiscordInteraction(request, env);
    }

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
        let server = await env.DB.prepare(
          "SELECT id, name, owner_user_id, discord_guild_id, discord_guild_name, status, staff_count, discord_member_count, description, announcement, current_activity, server_type, created_at, staff_role_id, whitelisted_role_id, discord_synced_at FROM servers WHERE id = ?"
        ).bind(serverId).first();
        if (!server) return json({ error: "Server not found." }, 404, origin);
        server = await refreshDiscordCounts(env, server);
        let visibleStatus = server.status;
        if (server.status === "whitelisted") {
          const authorization = request.headers.get("Authorization") || "";
          const token = authorization.startsWith("Bearer ") ? authorization.slice(7) : "";
          let viewer = null;
          try { viewer = token ? await verify(token, env.SESSION_SECRET) : null; } catch { viewer = null; }
          let allowed = !!viewer && viewer.sub === server.owner_user_id;
          if (viewer && !allowed && env.DISCORD_BOT_TOKEN && (server.whitelisted_role_id || server.staff_role_id)) {
            try {
              const member = await getDiscordMember(env, server.discord_guild_id, viewer.sub);
              const roles = member && Array.isArray(member.roles) ? member.roles : [];
              allowed = roles.includes(server.whitelisted_role_id) || roles.includes(server.staff_role_id);
            } catch (error) {
              console.error("Whitelist status check failed:", error);
              allowed = false;
            }
          }
          if (!allowed) visibleStatus = "offline";
        }
        delete server.owner_user_id;
        delete server.discord_guild_id;
        delete server.staff_role_id;
        delete server.whitelisted_role_id;
        delete server.discord_synced_at;
        server.status = visibleStatus;
        if (visibleStatus !== "online") server.current_activity = "";
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
        let server = await env.DB.prepare(
          "SELECT id, name, owner_user_id, discord_guild_id, status, staff_count, discord_member_count, description, announcement, current_activity, server_type, discord_guild_name, staff_role_id, whitelisted_role_id, discord_synced_at FROM servers WHERE id = ?"
        ).bind(serverId).first();
        if (!server) return json({ error: "Server not found." }, 404, origin);
        const isOwner = server.owner_user_id === user.sub;
        let isStaff = false;
        if (!isOwner && server.staff_role_id && env.DISCORD_BOT_TOKEN) {
          try {
            const member = await getDiscordMember(env, server.discord_guild_id, user.sub);
            isStaff = !!member && Array.isArray(member.roles) && member.roles.includes(server.staff_role_id);
          } catch (error) {
            console.error("Staff role verification failed:", error);
            return json({ error: "We couldn't verify your Discord roles. Please try again shortly." }, 503, origin);
          }
        }
        if (!isOwner && !isStaff) {
          return json({ error: "You need the community's configured Discord staff role to access this page." }, 403, origin);
        }
        server = await refreshDiscordCounts(env, server);
        if (request.method === "GET") {
          let roles = [];
          if (isOwner) {
            try {
              roles = await discordBotFetch(env, "/guilds/" + encodeURIComponent(server.discord_guild_id) + "/roles");
              roles = roles.filter(role => !role.managed && role.name !== "@everyone")
                .map(role => ({ id: role.id, name: role.name, position: role.position }));
              roles.sort((a,b) => b.position-a.position);
            } catch (error) {
              console.error("Could not load Discord roles:", error);
              return json({ error: "Could not load Discord roles. Make sure the Liberty Link bot is in this server." }, 503, origin);
            }
          }
          delete server.discord_guild_id;
          delete server.owner_user_id;
          delete server.discord_synced_at;
          return json({ server, is_owner: isOwner, roles }, 200, origin);
        }
        if (request.method === "PATCH") {
          let body;
          try { body = await request.json(); } catch { return json({ error: "Invalid request body." }, 400, origin); }
          const status = String(body.status || "").toLowerCase();
          const description = String(body.description || "").trim().slice(0, 500);
          const announcement = String(body.announcement || "").trim().slice(0, 300);
          const currentActivity = String(body.current_activity || "").trim().slice(0, 100);
          if (!["online", "offline", "whitelisted"].includes(status)) return json({ error: "Choose online, whitelisted, or offline status." }, 400, origin);
          const requestedWhitelistRole = Object.prototype.hasOwnProperty.call(body, "whitelisted_role_id") ? String(body.whitelisted_role_id || "") : String(server.whitelisted_role_id || "");
          if (status === "whitelisted" && !requestedWhitelistRole) return json({ error: "Select a Discord whitelist role before setting the server to Whitelisted." }, 400, origin);
          let staffRoleId = server.staff_role_id;
          let whitelistedRoleId = server.whitelisted_role_id;
          if (Object.prototype.hasOwnProperty.call(body, "staff_role_id") || Object.prototype.hasOwnProperty.call(body, "whitelisted_role_id")) {
            if (!isOwner) return json({ error: "Only the community owner can change the staff role." }, 403, origin);
            if (Object.prototype.hasOwnProperty.call(body, "staff_role_id")) staffRoleId = String(body.staff_role_id || "") || null;
            if (Object.prototype.hasOwnProperty.call(body, "whitelisted_role_id")) whitelistedRoleId = String(body.whitelisted_role_id || "") || null;
            const roles = await discordBotFetch(env, "/guilds/" + encodeURIComponent(server.discord_guild_id) + "/roles");
            for (const selectedRoleId of [staffRoleId, whitelistedRoleId]) {
              if (selectedRoleId && !roles.some(role => role.id === selectedRoleId && !role.managed && role.name !== "@everyone")) {
                return json({ error: "Choose valid roles from this Discord server." }, 400, origin);
              }
            }
          }
          await env.DB.prepare(
            "UPDATE servers SET status = ?, description = ?, announcement = ?, current_activity = ?, staff_role_id = ?, whitelisted_role_id = ?, discord_synced_at = NULL WHERE id = ?"
          ).bind(status, description, announcement, currentActivity, staffRoleId, whitelistedRoleId, serverId).run();
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
            env.DB.prepare("INSERT INTO servers (id, name, owner_user_id, discord_guild_id, discord_guild_name, join_code, created_at, server_type) VALUES (?, ?, ?, ?, ?, ?, ?, 'normal')")
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

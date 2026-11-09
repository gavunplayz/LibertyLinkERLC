// Register Liberty Link's global Discord slash commands.
// Requires Node.js 18+ and DISCORD_BOT_TOKEN in your local environment.
// Never commit your bot token to GitHub or share it in chat.

const applicationId = process.env.DISCORD_APPLICATION_ID || "1527089890041528390";
const token = process.env.DISCORD_BOT_TOKEN;

if (!token) {
  console.error("Missing DISCORD_BOT_TOKEN environment variable.");
  process.exit(1);
}

const commands = [
  {
    name: "status",
    description: "Change your Liberty Link community's server status",
    type: 1,
    options: [
      {
        name: "value",
        description: "The status to apply",
        type: 3,
        required: true,
        choices: [
          { name: "Online", value: "online" },
          { name: "Offline", value: "offline" },
          { name: "Whitelisted", value: "whitelisted" }
        ]
      }
    ]
  },
  {
    name: "activity",
    description: "Set or clear the current Liberty Link activity",
    type: 1,
    options: [
      {
        name: "text",
        description: "Activity text (up to 100 characters), or CLEAR",
        type: 3,
        required: true,
        max_length: 100
      }
    ]
  }
];

const response = await fetch(
  `https://discord.com/api/v10/applications/${applicationId}/commands`,
  {
    method: "PUT",
    headers: {
      Authorization: `Bot ${token}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify(commands)
  }
);

const body = await response.text();
if (!response.ok) {
  console.error(`Discord command registration failed (${response.status}):`);
  console.error(body);
  process.exit(1);
}

console.log("Liberty Link slash commands registered successfully.");
console.log(body);

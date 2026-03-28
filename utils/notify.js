export async function sendDiscordNotification(url, message, color = 0x00FF00, title = '🚀 SOL/USDC Trading Bot Alert') {
  if (!url || !url.startsWith('https://discord.com/api/webhooks/')) {
    return;
  }

  const payload = {
    embeds: [
      {
        title: title,
        description: message,
        color: color,
        timestamp: new Date().toISOString(),
        footer: {
          text: "Antigravity Trading System"
        }
      }
    ]
  };

  try {
    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    });

    if (!response.ok) {
      console.error(`Discord Webhook Error: ${response.statusText}`);
    }
  } catch (err) {
    console.error(`Failed to send Discord notification: ${err.message}`);
  }
}

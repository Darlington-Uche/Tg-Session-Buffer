const TelegramBot = require("node-telegram-bot-api");
const axios = require("axios");
const express = require("express");
const rateLimit = require("express-rate-limit");

// Configuration
const config = {
  token: process.env.BOT_TOKEN || "YOUR_BOT_TOKEN",
  sessionServiceUrl: "https://pettai-darlington-session.onrender.com",
  webhookUrl: "https://tg-session-buffer-1.onrender.com",
  port: process.env.PORT || 3000,
  sessionTimeout: 15 * 60 * 1000, // 15 minutes
  maxRequests: 100, // per windowMs
  requestWindow: 15 * 60 * 1000, // 15 minutes
};

// Initialize bot and express
const bot = new TelegramBot(config.token, {
  polling: false,
  filepath: false,
});
const app = express();

// Rate limiting
const limiter = rateLimit({
  windowMs: config.requestWindow,
  max: config.maxRequests,
  message: "Too many requests, please try again later.",
});
app.use(limiter);

// Middleware
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// State management
class UserStateManager {
  constructor() {
    this.states = new Map();
  }

  setState(chatId, state) {
    this.clearState(chatId);
    const timeout = setTimeout(() => {
      this.clearState(chatId);
      bot.sendMessage(
        chatId,
        "⌛ Session timed out. Use /start to begin again."
      );
    }, config.sessionTimeout);
    this.states.set(chatId, { ...state, timeout });
  }

  getState(chatId) {
    return this.states.get(chatId);
  }

  clearState(chatId) {
    const state = this.states.get(chatId);
    if (state && state.timeout) clearTimeout(state.timeout);
    this.states.delete(chatId);
  }
}

const userStates = new UserStateManager();

// Webhook setup
app.get("/set-webhook", async (req, res) => {
  try {
    await bot.setWebHook(`${config.webhookUrl}/webhook`);
    res.send("Webhook set successfully");
  } catch (error) {
    console.error("Webhook setup error:", error);
    res.status(500).send("Error setting webhook");
  }
});

app.post("/webhook", (req, res) => {
  bot.processUpdate(req.body);
  res.sendStatus(200);
});

// Helper functions
function escapeMarkdownV2(text) {
  return text.replace(/[_*[\]()~`>#+-=|{}.!]/g, "\\$&");
}

async function handleApiError(chatId, error) {
  console.error("API Error:", error);
  const message = error.response
    ? error.response.data.error || "Service unavailable"
    : error.message;

  await bot.sendMessage(
    chatId,
    `❌ Error: ${message}\n\nUse /start to try again.`
  );
}

// Bot commands
bot.onText(/\/start/, async (msg) => {
  const chatId = msg.chat.id;
  userStates.clearState(chatId);

  await bot.sendMessage(
    chatId,
    "Welcome to Session Creator Bot\n\n" +
    "I can help you create Telegram sessions.\n\nClick below to begin:",
    {
      reply_markup: {
        inline_keyboard: [
          [{ text: "Get Session 🧩", callback_data: "get_session" }],
        ],
      },
    }
  );
});

bot.onText(/\/help/, async (msg) => {
  const chatId = msg.chat.id;
  await bot.sendMessage(
    chatId,
    "Help Guide\n\n" +
    "1. Use /start to begin\n" +
    "2. Click \"Get Session\" button\n" +
    "3. Enter your phone number in international format (e.g., +123456789)\n" +
    "4. Enter the verification code you receive\n\n" +
    "Note: This bot does not store any personal information!"
  );
});

// Callback queries
bot.on("callback_query", async (query) => {
  const chatId = query.message.chat.id;
  const data = query.data;

  try {
    if (data === "get_session") {
      userStates.setState(chatId, { step: "awaiting_phone" });
      await bot.sendMessage(
        chatId,
        "📱 Send your phone number in international format (e.g., +123456789)"
      );
    }
  } catch (error) {
    console.error("Callback error:", error);
    await handleApiError(chatId, error);
    userStates.clearState(chatId);
  }
});

// Message handling
bot.on("message", async (msg) => {
  const chatId = msg.chat.id;
  const text = msg.text;
  const state = userStates.getState(chatId);

  if (!state || !text) return;

  try {
    if (state.step === "awaiting_phone") {
      if (!/^\+[1-9]\d{7,14}$/.test(text)) {
        throw new Error(
          "Invalid phone number format. Please use international format (e.g., +123456789)"
        );
      }

      await bot.sendMessage(chatId, "⌛ Sending verification code...");

      const response = await axios.post(`${config.sessionServiceUrl}/send_code`, {
        phone: text,
      });

      if (!response.data.success) {
        throw new Error(response.data.error || "Failed to send code");
      }

      userStates.setState(chatId, {
        step: "awaiting_code",
        phone: text,
      });

      await bot.sendMessage(
        chatId,
        "📨 Verification code sent! Please enter the code you received."
      );
    } else if (state.step === "awaiting_code") {
      if (!/^\d{5,6}$/.test(text)) {
        throw new Error("Invalid code format. Please enter 5 or 6 digits.");
      }

      await bot.sendMessage(chatId, "⌛ Creating session...");

      const response = await axios.post(
        `${config.sessionServiceUrl}/create_session`,
        {
          phone: state.phone,
          code: text,
        }
      );

      if (!response.data.success) {
        throw new Error(response.data.error || "Session creation failed");
      }

      // Only use Markdown for the session display
      await bot.sendMessage(
        chatId,
        "✅ Session created successfully!\n\n" +
        "Session string:\n" +
        `\`\`\`${response.data.session}\`\`\`\n\n` +
        "⚠️ Warning: Do not share this with anyone!",
        { parse_mode: "MarkdownV2" }
      );

      userStates.clearState(chatId);
    }
  } catch (error) {
    await handleApiError(chatId, error);
    userStates.clearState(chatId);
  }
});

// Error handling
bot.on("polling_error", (error) => {
  console.error("Polling error:", error);
});

bot.on("webhook_error", (error) => {
  console.error("Webhook error:", error);
});

// Start server
app.listen(config.port, () => {
  console.log(`Server running on port ${config.port}`);
  console.log(`Webhook URL: ${config.webhookUrl}/webhook`);
});

process.on("unhandledRejection", (reason) => {
  console.error("Unhandled Rejection:", reason);
});

process.on("uncaughtException", (error) => {
  console.error("Uncaught Exception:", error);
});
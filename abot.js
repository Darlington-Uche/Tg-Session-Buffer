const TelegramBot = require("node-telegram-bot-api");
const axios = require("axios");
const express = require("express");

// Configuration
const token = process.env.BOT_TOKEN;
const SESSION_SERVICE_URL = "https://pettai-darlington-session.onrender.com";
const WEBHOOK_URL = "https://tg-session-buffer-1.onrender.com"; // Replace with your actual domain
const PORT = process.env.PORT || 3000;

// Initialize bot (without polling)
const bot = new TelegramBot(token);
const app = express();
const userStates = {};

// Middleware to parse JSON
app.use(express.json());

// Set webhook route (call this once to setup)
app.get('/set-webhook', async (req, res) => {
    try {
        await bot.setWebHook(`${WEBHOOK_URL}/webhook`);
        res.send('Webhook set successfully');
    } catch (error) {
        res.status(500).send('Error setting webhook: ' + error.message);
    }
});

// Webhook endpoint
app.post('/webhook', (req, res) => {
    bot.processUpdate(req.body);
    res.sendStatus(200);
});

// Start server
app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
    console.log(`Webhook URL: ${WEBHOOK_URL}/webhook`);
});
// Utility: Clear state
async function clearUserState(chatId) {
    if (userStates[chatId]?.timeout) {
        clearTimeout(userStates[chatId].timeout);
    }
    delete userStates[chatId];
}

// Utility: Timeout user session after 15 mins
function setActionTimeout(chatId) {
    userStates[chatId].timeout = setTimeout(async () => {
        try {
            const msg = await bot.sendMessage(chatId, "⌛ Session timed out. Use /start to begin again.", { parse_mode: "MarkdownV2" });
            setTimeout(() => bot.deleteMessage(chatId, msg.message_id), 2 * 60 * 1000);
        } catch (_) {}
        clearUserState(chatId);
    }, 15 * 60 * 1000);
}

// Delete message after short delay
function deleteAfter(chatId, msgId, delay = 2 * 60 * 1000) {
    setTimeout(() => bot.deleteMessage(chatId, msgId).catch(() => {}), delay);
}

// ───────────────────────────────────────────────────────
// Start command
bot.onText(/\/start/, async (msg) => {
    const chatId = msg.chat.id;
    await clearUserState(chatId);
    await bot.deleteMessage(chatId, msg.message_id).catch(() => {});

    const welcome = await bot.sendMessage(chatId,
        `*Welcome to Session Creator Bot*\n\n` +
        `I can help you create Telegram sessions.\n\nClick below to begin:`,
        {
            parse_mode: "MarkdownV2",
            reply_markup: {
                inline_keyboard: [[{ text: "Get Session 🧩", callback_data: "get_session" }]]
            }
        }
    );
    deleteAfter(chatId, welcome.message_id);
});

// ───────────────────────────────────────────────────────
// Handle button clicks
bot.on("callback_query", async (query) => {
    const chatId = query.message.chat.id;
    const data = query.data;
    await bot.deleteMessage(chatId, query.message.message_id).catch(() => {});
    await clearUserState(chatId);

    if (data === "get_session") {
        userStates[chatId] = { step: "awaiting_phone" };
        setActionTimeout(chatId);

        const prompt = await bot.sendMessage(chatId,
            "📱 Send your phone number in *international format* (e.g., `+123456789`)",
            { parse_mode: "MarkdownV2" }
        );
        deleteAfter(chatId, prompt.message_id);
    }
});

// ───────────────────────────────────────────────────────
// Handle user input
bot.on("message", async (msg) => {
    const chatId = msg.chat.id;
    const text = msg.text;
    if (!userStates[chatId]) return;

    await bot.deleteMessage(chatId, msg.message_id).catch(() => {});
    const state = userStates[chatId];

    try {
        if (state.step === "awaiting_phone") {
            if (!/^\+\d{8,15}$/.test(text)) throw new Error("Invalid phone number. Use format like `+123456789`");

            state.phone = text;
            state.step = "awaiting_code";

            const processing = await bot.sendMessage(chatId, "⌛ Sending verification code...", { parse_mode: "MarkdownV2" });
            deleteAfter(chatId, processing.message_id);

            const res = await axios.post(`${SESSION_SERVICE_URL}/send_code`, { phone: text });
            if (!res.data.success) throw new Error(res.data.error || "Failed to send code");

            const codePrompt = await bot.sendMessage(chatId, "📨 Code sent! Enter it here.", { parse_mode: "MarkdownV2" });
            deleteAfter(chatId, codePrompt.message_id);

        } else if (state.step === "awaiting_code") {
            if (!/^\d{5,6}$/.test(text)) throw new Error("Code must be 5 or 6 digits");

            const waitMsg = await bot.sendMessage(chatId, "⌛ Creating session...", { parse_mode: "MarkdownV2" });
            deleteAfter(chatId, waitMsg.message_id);

            const res = await axios.post(`${SESSION_SERVICE_URL}/create_session`, {
                phone: state.phone,
                code: text
            });

            if (!res.data.success) throw new Error(res.data.error || "Failed to create session");

            const result = await bot.sendMessage(chatId,
                "*✅ Session created\\!*\n\n" +
                "Your session string:\n" +
                `\`\`\`${res.data.session}\`\`\`\n\n` +
                "*⚠️ Do not share this with anyone\\!*",
                { parse_mode: "MarkdownV2" }
            );
            deleteAfter(chatId, result.message_id);

            clearUserState(chatId);
        }

    } catch (err) {
        const errMsg = await bot.sendMessage(chatId,
            `*❌ Error:* ${err.message.replaceAll('_', '\\_')}\n\nUse /start to try again.`,
            { parse_mode: "MarkdownV2" }
        );
        deleteAfter(chatId, errMsg.message_id);
        clearUserState(chatId);
    }
});
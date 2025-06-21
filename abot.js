const TelegramBot = require("node-telegram-bot-api");
const axios = require("axios");
const express = require("express");

// Configuration
const token = process.env.BOT_TOKEN;
const SESSION_SERVICE_URL = "https://pettai-darlington-session.onrender.com";
const WEBHOOK_URL = "https://tg-session-buffer-1.onrender.com";
const PORT = process.env.PORT || 3000;

// Initialize bot
const bot = new TelegramBot(token, { polling: false });
const app = express();
const userStates = {};

// Middleware
app.use(express.json());

// Webhook setup
app.get('/set-webhook', async (req, res) => {
    try {
        await bot.setWebHook(`${WEBHOOK_URL}/webhook`);
        res.send('Webhook set successfully');
    } catch (error) {
        res.status(500).send('Error setting webhook: ' + error.message);
    }
});

app.post('/webhook', (req, res) => {
    bot.processUpdate(req.body);
    res.sendStatus(200);
});

app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
    console.log(`Webhook URL: ${WEBHOOK_URL}/webhook`);
});

// Utility functions
async function clearUserState(chatId) {
    if (userStates[chatId]?.timeout) {
        clearTimeout(userStates[chatId].timeout);
    }
    delete userStates[chatId];
}

function setActionTimeout(chatId) {
    userStates[chatId].timeout = setTimeout(async () => {
        try {
            await bot.sendMessage(
                chatId, 
                "⌛ Session timed out. Use /start to begin again.", 
                { parse_mode: "MarkdownV2" }
            );
        } catch (_) {}
        await clearUserState(chatId);
    }, 15 * 60 * 1000);
}

// Bot commands
bot.onText(/\/start/, async (msg) => {
    const chatId = msg.chat.id;
    await clearUserState(chatId);

    await bot.sendMessage(
        chatId,
        `*Welcome to Session Creator Bot*\\n\\n` +
        `I can help you create Telegram sessions\\.\\n\\nClick below to begin:`,
        {
            parse_mode: "MarkdownV2",
            reply_markup: {
                inline_keyboard: [[{ text: "Get Session 🧩", callback_data: "get_session" }]]
            }
        }
    );
});

// Callback queries
bot.on("callback_query", async (query) => {
    const chatId = query.message.chat.id;
    const data = query.data;

    try {
        await clearUserState(chatId);

        if (data === "get_session") {
            userStates[chatId] = { step: "awaiting_phone" };
            setActionTimeout(chatId);

            await bot.sendMessage(
                chatId,
                "📱 *Send your phone number* in international format \\\\(e\\.g\\., \\+123456789\\\\)",
                { parse_mode: "MarkdownV2" }
            );
        }
    } catch (error) {
        console.error('Callback query error:', error);
    }
});

// Message handling
bot.on("message", async (msg) => {
    const chatId = msg.chat.id;
    const text = msg.text;

    if (!userStates[chatId] || !text) return;

    try {
        const state = userStates[chatId];

        if (state.step === "awaiting_phone") {
            // Validate phone number format
            if (!/^\+[1-9]\d{7,14}$/.test(text)) {
                throw new Error("Invalid phone number format. Please use international format (e.g., +123456789)");
            }

            state.phone = text;
            state.step = "awaiting_code";

            await bot.sendMessage(
                chatId, 
                "⌛ Sending verification code...", 
                { parse_mode: "MarkdownV2" }
            );

            // Call session service
            const response = await axios.post(`${SESSION_SERVICE_URL}/send_code`, { 
                phone: text 
            }).catch(err => {
                throw new Error(err.response?.data?.error || "Failed to send verification code");
            });

            if (!response.data.success) {
                throw new Error(response.data.error || "Failed to send code");
            }

            await bot.sendMessage(
                chatId, 
                "📨 Verification code sent! Please enter the code you received.", 
                { parse_mode: "MarkdownV2" }
            );

        } else if (state.step === "awaiting_code") {
            // Validate code format
            if (!/^\d{5,6}$/.test(text)) {
                throw new Error("Invalid code format. Please enter 5 or 6 digits.");
            }

            await bot.sendMessage(
                chatId, 
                "⌛ Creating session...", 
                { parse_mode: "MarkdownV2" }
            );

            // Call session service
            const response = await axios.post(`${SESSION_SERVICE_URL}/create_session`, {
                phone: state.phone,
                code: text
            }).catch(err => {
                throw new Error(err.response?.data?.error || "Failed to create session");
            });

            if (!response.data.success) {
                throw new Error(response.data.error || "Session creation failed");
            }

            await bot.sendMessage(
                chatId,
                "*✅ Session created successfully\\!*\\n\\n" +
                "*Session string:*\\n" +
                `\`\`\`${response.data.session}\`\`\`\\n\\n` +
                "*⚠️ Warning:* Do \\*not\\* share this with anyone\\!",
                { parse_mode: "MarkdownV2" }
            );

            await clearUserState(chatId);
        }
    } catch (error) {
        console.error('Message handling error:', error);

        const errorMessage = `*❌ Error:* ${escapeMarkdownV2(error.message)}\\n\\nUse /start to try again.`;

        try {
            await bot.sendMessage(
                chatId,
                errorMessage,
                { parse_mode: "MarkdownV2" }
            );
        } catch (sendError) {
            console.error('Failed to send error message:', sendError);
        }

        await clearUserState(chatId);
    }
});

// Helper function to escape MarkdownV2 special characters
function escapeMarkdownV2(text) {
    return text.replace(/[_*[\]()~`>#+-=|{}.!]/g, '\\$&');
}
const TelegramBot = require("node-telegram-bot-api");
const axios = require("axios");

// Configuration
const token = "7311393331:AAEATh5DVq6yUeCuYQYvkEviMOxnY8v_ars";
const SESSION_SERVICE_URL = "http://localhost:5000";

// Initialize bot
const bot = new TelegramBot(token, { polling: true });
const userStates = {};

// Helper function to clear user state and delete messages
async function clearUserState(chatId) {
    if (userStates[chatId]) {
        // Clear any pending timeout
        if (userStates[chatId].timeout) {
            clearTimeout(userStates[chatId].timeout);
        }
        
        // Delete processing message if exists
        if (userStates[chatId].processingMsgId) {
            try {
                await bot.deleteMessage(chatId, userStates[chatId].processingMsgId);
            } catch (e) {
                console.error("Error deleting processing message:", e.message);
            }
        }
        
        // Delete any other messages in the messagesToDelete array
        if (userStates[chatId].messagesToDelete) {
            for (const msgId of userStates[chatId].messagesToDelete) {
                try {
                    await bot.deleteMessage(chatId, msgId);
                } catch (e) {
                    console.error("Error deleting message:", e.message);
                }
            }
        }
        
        delete userStates[chatId];
    }
}

// Set timeout for user actions (15 minutes)
function setActionTimeout(chatId) {
    userStates[chatId].timeout = setTimeout(async () => {
        const timeoutMsg = await bot.sendMessage(
            chatId, 
            "⌛ Session creation timed out. Please start again with /start",
            { parse_mode: "MarkdownV2" }
        );
        
        // Add timeout message to deletion queue
        if (userStates[chatId]) {
            userStates[chatId].messagesToDelete = userStates[chatId].messagesToDelete || [];
            userStates[chatId].messagesToDelete.push(timeoutMsg.message_id);
        }
        
        await clearUserState(chatId);
    }, 15 * 60 * 1000); // 15 minutes
}

// Function to schedule message deletion
function scheduleMessageDeletion(chatId, msgId, delay = 2 * 60 * 1000) {
    setTimeout(async () => {
        try {
            await bot.deleteMessage(chatId, msgId);
        } catch (e) {
            console.error("Error deleting scheduled message:", e.message);
        }
    }, delay);
}

bot.onText(/\/start/, async (msg) => {
    const chatId = msg.chat.id;
    await clearUserState(chatId);
    
    // Delete the /start command message
    try {
        await bot.deleteMessage(chatId, msg.message_id);
    } catch (e) {
        console.error("Error deleting /start message:", e.message);
    }
    
    const welcomeMsg = await bot.sendMessage(chatId, 
        "*Welcome to Session Creator Bot*\n\n" +
        "I can help you create Telegram sessions\\.\n\n" +
        "Click below to begin:", 
        {
            parse_mode: "MarkdownV2",
            reply_markup: {
                inline_keyboard: [
                    [{ text: "Get Session 🧩", callback_data: "get_session" }]
                ]
            }
        }
    );
    
    // Schedule welcome message deletion
    scheduleMessageDeletion(chatId, welcomeMsg.message_id);
});

bot.on('callback_query', async (query) => {
    const chatId = query.message.chat.id;
    const data = query.data;

    if (data === "get_session") {
        await clearUserState(chatId);
        userStates[chatId] = { 
            step: "awaiting_phone",
            messagesToDelete: [query.message.message_id] // Track message for deletion
        };
        setActionTimeout(chatId);
        
        const phonePrompt = await bot.sendMessage(
            chatId,
            "📱 Please send your phone number in international format \\(e\\.g\\., \\+123456789\\)\\.\n\n" +
            "*Note:* This should be the number of the account you want to create session for\\.",
            {
                parse_mode: "MarkdownV2"
            }
        );
        
        userStates[chatId].processingMsgId = phonePrompt.message_id;
        userStates[chatId].messagesToDelete.push(phonePrompt.message_id);
    }
});

bot.on("message", async (msg) => {
    const chatId = msg.chat.id;
    const text = msg.text;
    
    if (!userStates[chatId]) return;
    
    try {
        // Track all messages for potential deletion
        userStates[chatId].messagesToDelete = userStates[chatId].messagesToDelete || [];
        userStates[chatId].messagesToDelete.push(msg.message_id);

        if (userStates[chatId].step === "awaiting_phone") {
            await bot.deleteMessage(chatId, msg.message_id);
            
            // Validate phone number format
            if (!text.match(/^\+\d{8,15}$/)) {
                throw new Error("Invalid phone format. Use international format (e.g., +123456789)");
            }
            
            userStates[chatId].phone = text;
            userStates[chatId].step = "awaiting_code";
            setActionTimeout(chatId);
            
            const processingMsg = await bot.sendMessage(
                chatId, 
                "⌛ Sending verification code to your Telegram account\\.\\.\\.",
                { parse_mode: "MarkdownV2" }
            );
            
            userStates[chatId].processingMsgId = processingMsg.message_id;
            userStates[chatId].messagesToDelete.push(processingMsg.message_id);
            
            // Send code request
            const response = await axios.post(`${SESSION_SERVICE_URL}/send_code`, {
                phone: text
            });
            
            if (!response.data.success) {
                throw new Error(response.data.error || "Failed to send verification code");
            }
            
            await bot.editMessageText(
                "📨 Verification code sent\\! Please enter the code you received\\.",
                {
                    chat_id: chatId,
                    message_id: userStates[chatId].processingMsgId,
                    parse_mode: "MarkdownV2"
                }
            );
            
        } else if (userStates[chatId].step === "awaiting_code") {
            await bot.deleteMessage(chatId, msg.message_id);
            
            // Validate code format (5-6 digits)
            if (!text.match(/^\d{5,6}$/)) {
                throw new Error("Invalid code format. Please enter 5-6 digit code");
            }
            
            const processingMsg = await bot.sendMessage(
                chatId, 
                "⌛ Creating session\\.\\.\\.",
                { parse_mode: "MarkdownV2" }
            );
            
            userStates[chatId].processingMsgId = processingMsg.message_id;
            userStates[chatId].messagesToDelete.push(processingMsg.message_id);
            
            // Create session
            const response = await axios.post(`${SESSION_SERVICE_URL}/create_session`, {
                phone: userStates[chatId].phone,
                code: text
            });
            
            if (!response.data.success) {
                throw new Error(response.data.error || "Failed to create session");
            }
            
            const successMsg = await bot.sendMessage(
                chatId,
                "*✅ Session created successfully\\!*\n\n" +
                "Here is your session string:\n\n" +
                `\`\`\`\n${response.data.session}\n\`\`\`\n\n` +
                "*⚠️ Keep this safe and don\\'t share it with anyone\\!*",
                {
                    parse_mode: "MarkdownV2"
                }
            );
            
            // Schedule deletion of success message after 2 minutes
            scheduleMessageDeletion(chatId, successMsg.message_id);
            
            await clearUserState(chatId);
        }
    } catch (error) {
        console.error(`Error for chat ${chatId}:`, error.message);
        
        const errorMessage = `*❌ Error\\:* ${error.message}\n\n` +
            "Please try again with /start";
        
        const errorMsg = await bot.sendMessage(chatId, errorMessage, { 
            parse_mode: "MarkdownV2" 
        });
        
        // Schedule deletion of error message after 2 minutes
        scheduleMessageDeletion(chatId, errorMsg.message_id);
        
        await clearUserState(chatId);
    }
});

console.log('Bot is running in polling mode...');

import asyncio
from telethon import TelegramClient
from telethon.sessions import StringSession
from telethon.errors import SessionPasswordNeededError, PhoneCodeInvalidError
from flask import Flask, request, jsonify
import logging

app = Flask(__name__)

# Configure logging
logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

# Telegram API credentials
api_id = 24437159
api_hash = "e042a17a77502674470b0eadf0fdd0d7"

# Session storage with expiration
sessions = {}
pending_phones = {}

# Create event loop
loop = asyncio.new_event_loop()
asyncio.set_event_loop(loop)

async def send_code_async(phone):
    """Send verification code to the specified phone number"""
    try:
        client = TelegramClient(StringSession(), api_id, api_hash)
        await client.connect()
        sent = await client.send_code_request(phone)
        sessions[phone] = {
            'client': client,
            'phone_code_hash': sent.phone_code_hash
        }
        return True
    except Exception as e:
        logger.error(f"Error sending code to {phone}: {str(e)}")
        if phone in sessions:
            await sessions[phone]['client'].disconnect()
            del sessions[phone]
        raise

async def create_session_async(phone, code):
    """Create session with received code"""
    if phone not in sessions:
        raise ValueError('No active session for this phone. Request a new code.')
    
    client = sessions[phone]['client']
    phone_code_hash = sessions[phone]['phone_code_hash']
    
    try:
        await client.sign_in(
            phone=phone,
            code=code,
            phone_code_hash=phone_code_hash
        )
    except SessionPasswordNeededError:
        raise ValueError('2FA is enabled. This service doesn\'t support 2FA accounts.')
    except PhoneCodeInvalidError:
        raise ValueError('Invalid verification code provided.')
    except Exception as e:
        logger.error(f"Error creating session for {phone}: {str(e)}")
        raise ValueError('Failed to create session. Please try again.')
    
    session_str = client.session.save()
    await client.disconnect()
    del sessions[phone]
    return session_str

async def create_session_async(phone, code):
    """Create session with received code"""
    logger.info(f"Attempting to create session for {phone}")
    
    if phone not in sessions:
        logger.error(f"No active session found for {phone}")
        raise ValueError('No active session for this phone. Request a new code.')

    client = sessions[phone]['client']
    phone_code_hash = sessions[phone]['phone_code_hash']

    try:
        logger.info(f"Attempting sign in for {phone}")
        await client.sign_in(
            phone=phone,
            code=code,
            phone_code_hash=phone_code_hash
        )
        logger.info(f"Sign in successful for {phone}")
        
        session_str = client.session.save()
        logger.info(f"Session string generated for {phone}")
        
        await client.disconnect()
        del sessions[phone]
        return session_str
        
    except SessionPasswordNeededError:
        logger.error(f"2FA enabled for {phone}")
        raise ValueError('2FA is enabled. This service doesn\'t support 2FA accounts.')
    except PhoneCodeInvalidError:
        logger.error(f"Invalid code for {phone}")
        raise ValueError('Invalid verification code provided.')
    except Exception as e:
        logger.error(f"Error creating session for {phone}: {str(e)}")
        raise ValueError('Failed to create session. Please try again.')

def run_async(coro):
    """Run coroutine in the event loop"""
    return loop.run_until_complete(coro)

@app.route('/send_code', methods=['POST'])
def send_code():
    """Endpoint to request verification code"""
    data = request.json
    phone = data.get('phone')
    
    if not phone:
        return jsonify({'success': False, 'error': 'Phone number is required'}), 400
    
    try:
        run_async(send_code_async(phone))
        return jsonify({'success': True, 'message': 'Code sent successfully'})
    except Exception as e:
        return jsonify({'success': False, 'error': str(e)}), 500
@app.route('/create_session', methods=['POST'])
def create_session():
    """Endpoint to create session with verification code"""
    data = request.json
    phone = data.get('phone')
    code = data.get('code')

    if not phone or not code:
        return jsonify({'success': False, 'error': 'Phone and code are required'}), 400

    try:
        session_str = run_async(create_session_async(phone, code))
        return jsonify({
            'success': True,
            'session': session_str,
            'message': 'Session created successfully'
        })
    except ValueError as e:
        logger.error(f"Session creation failed for {phone}: {str(e)}")
        return jsonify({'success': False, 'error': str(e)}), 400
    except Exception as e:
        logger.error(f"Unexpected error for {phone}: {str(e)}")
        return jsonify({'success': False, 'error': 'Internal server error'}), 500
if __name__ == '__main__':
    app.run(host='0.0.0.0', port=5000)
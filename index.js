// Crypto polyfill for Baileys compatibility
const crypto = require('crypto');
if (!global.crypto) {
    global.crypto = crypto;
}

const { default: makeWASocket, useMultiFileAuthState, DisconnectReason } = require('@whiskeysockets/baileys');
const qrcode = require('qrcode-terminal');
const express = require('express');
const fs = require('fs');
const path = require('path');
const pino = require('pino');
const axios = require('axios');
const { spawn } = require('child_process');
const { promisify } = require('util');
const stream = require('stream');
const pipeline = promisify(stream.pipeline);

const app = express();
app.use(express.json());

// ============================================
// CONFIGURATION
// ============================================
const CONFIG = {
    TEMP_DIR: '/tmp/whatsapp-videos/',
    MAX_VIDEO_SIZE_MB: 100,
    MAX_DOCUMENT_SIZE_MB: 2000,
    PORT: process.env.PORT || 5000,
    LOG_LEVEL: process.env.LOG_LEVEL || 'silent',
    DOWNLOAD_TIMEOUT: 300000, // 5 minutes
    FFMPEG_TIMEOUT: 600000 // 10 minutes for large files
};

// ============================================
// STATE MANAGEMENT
// ============================================
let sock = null;
let isConnected = false;
let connectionAttempts = 0;
const MAX_RECONNECT_ATTEMPTS = 5;

// Logger
const logger = pino({ level: CONFIG.LOG_LEVEL });

// Create temp directory
if (!fs.existsSync(CONFIG.TEMP_DIR)) {
    fs.mkdirSync(CONFIG.TEMP_DIR, { recursive: true });
}

// ============================================
// WHATSAPP CONNECTION
// ============================================
async function connectToWhatsApp() {
    try {
        const { state, saveCreds } = await useMultiFileAuthState('auth_info_baileys');

        sock = makeWASocket({
            auth: state,
            printQRInTerminal: false,
            logger: logger,
            browser: ['WhatsApp Video API', 'Chrome', '1.0.0'],
            defaultQueryTimeoutMs: 60000
        });

        sock.ev.on('creds.update', saveCreds);

        sock.ev.on('connection.update', async (update) => {
            const { connection, lastDisconnect, qr } = update;

            if (qr) {
                console.log('\n' + '='.repeat(50));
                console.log('📱 SCAN THIS QR CODE WITH WHATSAPP');
                console.log('='.repeat(50) + '\n');
                qrcode.generate(qr, { small: true });
            }

            if (connection === 'close') {
                const statusCode = lastDisconnect?.error?.output?.statusCode;
                const shouldReconnect = statusCode !== DisconnectReason.loggedOut;

                console.log('❌ Connection closed:', lastDisconnect?.error?.message);
                isConnected = false;

                if (shouldReconnect && connectionAttempts < MAX_RECONNECT_ATTEMPTS) {
                    connectionAttempts++;
                    console.log(`🔄 Reconnecting... (Attempt ${connectionAttempts}/${MAX_RECONNECT_ATTEMPTS})`);
                    setTimeout(connectToWhatsApp, 5000);
                } else if (connectionAttempts >= MAX_RECONNECT_ATTEMPTS) {
                    console.error('⚠️ Max reconnection attempts reached. Please restart the service.');
                } else {
                    console.error('⚠️ Logged out. Please scan QR code again.');
                }
            } else if (connection === 'open') {
                console.log('\n✅ WhatsApp Connected Successfully!');
                console.log('📱 Phone Number:', sock.user?.id || 'Unknown');
                isConnected = true;
                connectionAttempts = 0;
            }
        });

        sock.ev.on('connection.error', (error) => {
            console.error('❌ Connection Error:', error.message);
        });

    } catch (error) {
        console.error('❌ Failed to initialize WhatsApp:', error.message);
        setTimeout(connectToWhatsApp, 10000);
    }
}

// ============================================
// UTILITY FUNCTIONS
// ============================================

function formatFileSize(bytes) {
    if (bytes === 0) return '0 Bytes';
    const k = 1024;
    const sizes = ['Bytes', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}

function validateChatId(chatId) {
    if (!chatId || typeof chatId !== 'string') {
        throw new Error('Invalid chatId: must be a string');
    }

    const trimmedChatId = chatId.trim();
    const validPattern = /^[\d]+@(s\.whatsapp\.net|c\.us|g\.us|broadcast)$/;

    if (!validPattern.test(trimmedChatId)) {
        throw new Error('Invalid chatId format. Expected: "923164525711@s.whatsapp.net" or "120363424911005190@g.us"');
    }

    if (trimmedChatId.endsWith('@c.us')) {
        const number = trimmedChatId.split('@')[0];
        console.log(`🔄 Normalizing ${trimmedChatId} to ${number}@s.whatsapp.net`);
        return `${number}@s.whatsapp.net`;
    }

    return trimmedChatId;
}

async function downloadFile(url, outputPath) {
    console.log(`📥 Downloading: ${url.substring(0, 100)}...`);
    
    const writer = fs.createWriteStream(outputPath);
    
    const response = await axios({
        url,
        method: 'GET',
        responseType: 'stream',
        timeout: CONFIG.DOWNLOAD_TIMEOUT,
        maxContentLength: CONFIG.MAX_DOCUMENT_SIZE_MB * 1024 * 1024,
        maxBodyLength: CONFIG.MAX_DOCUMENT_SIZE_MB * 1024 * 1024
    });

    await pipeline(response.data, writer);
    
    const stats = fs.statSync(outputPath);
    console.log(`✅ Downloaded: ${formatFileSize(stats.size)}`);
    
    return stats.size;
}

async function mergeWithFFmpeg(videoPath, audioPath, outputPath) {
    return new Promise((resolve, reject) => {
        console.log(`🔧 Starting FFmpeg merge...`);
        console.log(`   Video: ${videoPath}`);
        console.log(`   Audio: ${audioPath}`);
        console.log(`   Output: ${outputPath}`);

        const ffmpeg = spawn('ffmpeg', [
            '-i', videoPath,
            '-i', audioPath,
            '-c:v', 'copy',
            '-c:a', 'aac',
            '-strict', 'experimental',
            '-y',
            outputPath
        ]);

        let stderr = '';

        ffmpeg.stderr.on('data', (data) => {
            stderr += data.toString();
        });

        ffmpeg.on('close', (code) => {
            if (code === 0) {
                const stats = fs.statSync(outputPath);
                console.log(`✅ FFmpeg merge completed: ${formatFileSize(stats.size)}`);
                resolve(stats.size);
            } else {
                console.error(`❌ FFmpeg failed with code ${code}`);
                console.error(stderr);
                reject(new Error(`FFmpeg process exited with code ${code}`));
            }
        });

        ffmpeg.on('error', (error) => {
            console.error(`❌ FFmpeg error: ${error.message}`);
            reject(error);
        });

        // Timeout handler
        const timeout = setTimeout(() => {
            ffmpeg.kill();
            reject(new Error('FFmpeg process timeout'));
        }, CONFIG.FFMPEG_TIMEOUT);

        ffmpeg.on('close', () => clearTimeout(timeout));
    });
}

function cleanupFiles(...filePaths) {
    for (const filePath of filePaths) {
        try {
            if (fs.existsSync(filePath)) {
                fs.unlinkSync(filePath);
                console.log(`🗑️  Cleaned up: ${path.basename(filePath)}`);
            }
        } catch (error) {
            console.error(`⚠️  Failed to cleanup ${filePath}:`, error.message);
        }
    }
}

function sanitizeFilename(filename) {
    return filename
        .replace(/[^a-zA-Z0-9._-]/g, '_')
        .substring(0, 200);
}

// ============================================
// MAIN API ENDPOINT
// ============================================

app.post('/api/send-video-url', async (req, res) => {
    const startTime = Date.now();
    const tempFiles = [];

    try {
        // ========================================
        // 1. VALIDATE CONNECTION
        // ========================================
        if (!isConnected || !sock) {
            return res.status(503).json({
                success: false,
                error: 'WhatsApp not connected',
                message: 'Please ensure WhatsApp is connected',
                errorCode: 'NOT_CONNECTED'
            });
        }

        // ========================================
        // 2. VALIDATE INPUT
        // ========================================
        const { type, video_url, audio_url, chat_id, caption, filename } = req.body;

        if (!type || !video_url || !chat_id) {
            return res.status(400).json({
                success: false,
                error: 'Missing required fields',
                message: 'Required: type, video_url, chat_id',
                errorCode: 'MISSING_FIELDS',
                example: {
                    direct: {
                        type: "direct",
                        video_url: "https://...",
                        chat_id: "923164525711@s.whatsapp.net",
                        caption: "Optional",
                        filename: "video.mp4"
                    },
                    merge: {
                        type: "merge",
                        video_url: "https://...",
                        audio_url: "https://...",
                        chat_id: "923164525711@s.whatsapp.net",
                        caption: "Optional",
                        filename: "video.mp4"
                    }
                }
            });
        }

        if (type === 'merge' && !audio_url) {
            return res.status(400).json({
                success: false,
                error: 'Missing audio_url for merge type',
                errorCode: 'MISSING_AUDIO_URL'
            });
        }

        // Validate chat ID
        let validatedChatId;
        try {
            validatedChatId = validateChatId(chat_id);
        } catch (error) {
            return res.status(400).json({
                success: false,
                error: 'Invalid chatId',
                message: error.message,
                errorCode: 'INVALID_CHATID'
            });
        }

        // ========================================
        // 3. LOG REQUEST
        // ========================================
        console.log('\n' + '='.repeat(70));
        console.log('📤 NEW VIDEO REQUEST');
        console.log('='.repeat(70));
        console.log(`🎯 Type: ${type.toUpperCase()}`);
        console.log(`💬 Chat: ${validatedChatId}`);
        if (caption) console.log(`📝 Caption: ${caption}`);
        console.log('='.repeat(70));

        // ========================================
        // 4. PROCESS VIDEO
        // ========================================
        let finalVideoPath;
        let fileSizeBytes;
        const timestamp = Date.now();
        const safeFilename = sanitizeFilename(filename || 'video.mp4');

        if (type === 'direct') {
            // ========================================
            // DIRECT DOWNLOAD (Progressive format)
            // ========================================
            finalVideoPath = path.join(CONFIG.TEMP_DIR, `${timestamp}_direct_${safeFilename}`);
            tempFiles.push(finalVideoPath);

            try {
                fileSizeBytes = await downloadFile(video_url, finalVideoPath);
            } catch (error) {
                cleanupFiles(...tempFiles);
                return res.status(500).json({
                    success: false,
                    error: 'Download failed',
                    message: error.message,
                    errorCode: 'DOWNLOAD_FAILED'
                });
            }

        } else if (type === 'merge') {
            // ========================================
            // DOWNLOAD + MERGE (Video + Audio)
            // ========================================
            const videoPath = path.join(CONFIG.TEMP_DIR, `${timestamp}_video.tmp`);
            const audioPath = path.join(CONFIG.TEMP_DIR, `${timestamp}_audio.tmp`);
            finalVideoPath = path.join(CONFIG.TEMP_DIR, `${timestamp}_merged_${safeFilename}`);
            
            tempFiles.push(videoPath, audioPath, finalVideoPath);

            try {
                // Download video and audio in parallel
                console.log('📥 Downloading video and audio...');
                const [videoSize, audioSize] = await Promise.all([
                    downloadFile(video_url, videoPath),
                    downloadFile(audio_url, audioPath)
                ]);

                console.log(`✅ Video downloaded: ${formatFileSize(videoSize)}`);
                console.log(`✅ Audio downloaded: ${formatFileSize(audioSize)}`);

                // Merge with FFmpeg
                fileSizeBytes = await mergeWithFFmpeg(videoPath, audioPath, finalVideoPath);

            } catch (error) {
                cleanupFiles(...tempFiles);
                return res.status(500).json({
                    success: false,
                    error: 'Processing failed',
                    message: error.message,
                    errorCode: error.message.includes('FFmpeg') ? 'FFMPEG_FAILED' : 'DOWNLOAD_FAILED'
                });
            }

        } else {
            return res.status(400).json({
                success: false,
                error: 'Invalid type',
                message: 'Type must be "direct" or "merge"',
                errorCode: 'INVALID_TYPE'
            });
        }

        // ========================================
        // 5. VALIDATE FILE SIZE
        // ========================================
        const fileSizeMB = fileSizeBytes / (1024 * 1024);

        if (fileSizeMB > CONFIG.MAX_DOCUMENT_SIZE_MB) {
            cleanupFiles(...tempFiles);
            return res.status(413).json({
                success: false,
                error: 'File too large',
                message: `File size (${fileSizeMB.toFixed(2)} MB) exceeds maximum (${CONFIG.MAX_DOCUMENT_SIZE_MB} MB)`,
                errorCode: 'FILE_TOO_LARGE'
            });
        }

        // ========================================
        // 6. DETERMINE SEND TYPE
        // ========================================
        let sendType;
        let reason;

        if (fileSizeMB <= CONFIG.MAX_VIDEO_SIZE_MB) {
            sendType = 'video';
            reason = `File size (${fileSizeMB.toFixed(2)} MB) is under ${CONFIG.MAX_VIDEO_SIZE_MB} MB`;
        } else {
            sendType = 'document';
            reason = `File size (${fileSizeMB.toFixed(2)} MB) exceeds ${CONFIG.MAX_VIDEO_SIZE_MB} MB`;
        }

        console.log(`📊 File size: ${formatFileSize(fileSizeBytes)} (${fileSizeMB.toFixed(2)} MB)`);
        console.log(`🔖 Sending as: ${sendType.toUpperCase()}`);
        console.log(`💭 Reason: ${reason}`);

        // ========================================
        // 7. READ FILE AND SEND
        // ========================================
        const fileBuffer = fs.readFileSync(finalVideoPath);

        let result;
        try {
            if (sendType === 'video') {
                result = await sock.sendMessage(validatedChatId, {
                    video: fileBuffer,
                    caption: caption || '',
                    mimetype: 'video/mp4'
                });
            } else {
                result = await sock.sendMessage(validatedChatId, {
                    document: fileBuffer,
                    mimetype: 'video/mp4',
                    fileName: safeFilename,
                    caption: caption || ''
                });
            }
        } catch (error) {
            console.error('❌ Send failed:', error.message);
            cleanupFiles(...tempFiles);

            return res.status(500).json({
                success: false,
                error: 'Failed to send message',
                message: error.message,
                errorCode: 'SEND_FAILED'
            });
        }

        // ========================================
        // 8. CLEANUP
        // ========================================
        cleanupFiles(...tempFiles);

        // ========================================
        // 9. SUCCESS RESPONSE
        // ========================================
        const processingTime = Date.now() - startTime;

        console.log(`✅ ${sendType.toUpperCase()} SENT SUCCESSFULLY!`);
        console.log(`⏱️  Total processing time: ${(processingTime / 1000).toFixed(2)}s`);
        console.log(`📨 Message ID: ${result.key.id}`);
        console.log('='.repeat(70) + '\n');

        res.status(200).json({
            success: true,
            message: `${sendType === 'video' ? 'Video' : 'Document'} sent successfully`,
            data: {
                messageId: result.key.id,
                chatId: validatedChatId,
                fileName: safeFilename,
                fileSize: formatFileSize(fileSizeBytes),
                fileSizeMB: parseFloat(fileSizeMB.toFixed(2)),
                processType: type,
                sentAs: sendType,
                reason: reason,
                caption: caption || null,
                timestamp: new Date().toISOString(),
                processingTimeMs: processingTime,
                processingTimeSec: parseFloat((processingTime / 1000).toFixed(2))
            }
        });

    } catch (error) {
        console.error('❌ Unexpected error:', error);
        cleanupFiles(...tempFiles);

        res.status(500).json({
            success: false,
            error: 'Internal server error',
            message: error.message,
            errorCode: 'INTERNAL_ERROR'
        });
    }
});

// ============================================
// HEALTH CHECK
// ============================================

app.get('/api/health', (req, res) => {
    // Check FFmpeg
    let ffmpegAvailable = false;
    try {
        require('child_process').execSync('ffmpeg -version', { stdio: 'ignore' });
        ffmpegAvailable = true;
    } catch (e) {
        ffmpegAvailable = false;
    }

    res.json({
        success: true,
        status: isConnected ? 'connected' : 'disconnected',
        whatsapp: {
            connected: isConnected,
            user: sock?.user || null
        },
        system: {
            ffmpeg: ffmpegAvailable,
            tempDir: CONFIG.TEMP_DIR,
            maxVideoSizeMB: CONFIG.MAX_VIDEO_SIZE_MB,
            maxDocumentSizeMB: CONFIG.MAX_DOCUMENT_SIZE_MB
        },
        uptime: process.uptime(),
        timestamp: new Date().toISOString()
    });
});

// ============================================
// API DOCS
// ============================================

app.get('/api/docs', (req, res) => {
    res.json({
        apiName: 'WhatsApp Video Sender (Direct URL)',
        version: '2.0.0',
        description: 'Send videos to WhatsApp using direct YouTube URLs',
        endpoints: {
            sendVideoUrl: {
                method: 'POST',
                path: '/api/send-video-url',
                description: 'Download and send video from direct URL',
                requestTypes: {
                    direct: {
                        description: 'Single progressive video (no FFmpeg needed)',
                        example: {
                            type: 'direct',
                            video_url: 'https://...',
                            chat_id: '923164525711@s.whatsapp.net',
                            caption: 'Check this!',
                            filename: 'video.mp4'
                        }
                    },
                    merge: {
                        description: 'Merge video + audio with FFmpeg',
                        example: {
                            type: 'merge',
                            video_url: 'https://...',
                            audio_url: 'https://...',
                            chat_id: '923164525711@s.whatsapp.net',
                            caption: 'High quality!',
                            filename: 'video.mp4'
                        }
                    }
                }
            },
            health: {
                method: 'GET',
                path: '/api/health',
                description: 'Check API health and FFmpeg availability'
            }
        },
        limits: {
            maxVideoSizeMB: CONFIG.MAX_VIDEO_SIZE_MB,
            maxDocumentSizeMB: CONFIG.MAX_DOCUMENT_SIZE_MB,
            downloadTimeoutSec: CONFIG.DOWNLOAD_TIMEOUT / 1000,
            ffmpegTimeoutSec: CONFIG.FFMPEG_TIMEOUT / 1000
        }
    });
});

// ============================================
// ERROR HANDLING
// ============================================

app.use((req, res) => {
    res.status(404).json({
        success: false,
        error: 'Endpoint not found',
        errorCode: 'NOT_FOUND',
        availableEndpoints: [
            'POST /api/send-video-url',
            'GET /api/health',
            'GET /api/docs'
        ]
    });
});

app.use((err, req, res, next) => {
    console.error('❌ Unhandled error:', err);
    res.status(500).json({
        success: false,
        error: 'Internal server error',
        message: err.message,
        errorCode: 'UNHANDLED_ERROR'
    });
});

// ============================================
// START SERVER
// ============================================

app.listen(CONFIG.PORT, () => {
    console.log('\n' + '='.repeat(70));
    console.log('🚀 WHATSAPP VIDEO SENDER (DIRECT URL + FFMPEG)');
    console.log('='.repeat(70));
    console.log(`📡 Server: http://localhost:${CONFIG.PORT}`);
    console.log(`📁 Temp Dir: ${CONFIG.TEMP_DIR}`);
    console.log(`🎥 Max Video: ${CONFIG.MAX_VIDEO_SIZE_MB} MB`);
    console.log(`📄 Max Document: ${CONFIG.MAX_DOCUMENT_SIZE_MB} MB`);
    console.log('\n📚 Endpoints:');
    console.log(`   POST http://localhost:${CONFIG.PORT}/api/send-video-url`);
    console.log(`   GET  http://localhost:${CONFIG.PORT}/api/health`);
    console.log(`   GET  http://localhost:${CONFIG.PORT}/api/docs`);
    console.log('='.repeat(70));
    console.log('⏳ Connecting to WhatsApp...\n');

    connectToWhatsApp();
});

// ============================================
// GRACEFUL SHUTDOWN
// ============================================

process.on('SIGINT', async () => {
    console.log('\n⏹️  Shutting down...');

    if (sock && isConnected) {
        try {
            await sock.logout();
            console.log('✅ Logged out from WhatsApp');
        } catch (error) {
            console.error('❌ Logout error:', error.message);
        }
    }

    // Cleanup temp directory
    try {
        const files = fs.readdirSync(CONFIG.TEMP_DIR);
        for (const file of files) {
            fs.unlinkSync(path.join(CONFIG.TEMP_DIR, file));
        }
        console.log('✅ Cleaned up temp files');
    } catch (error) {
        console.error('⚠️  Cleanup error:', error.message);
    }

    console.log('👋 Goodbye!\n');
    process.exit(0);
});

process.on('uncaughtException', (error) => {
    console.error('❌ Uncaught Exception:', error);
});

process.on('unhandledRejection', (reason, promise) => {
    console.error('❌ Unhandled Rejection:', reason);
});
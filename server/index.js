import express from "express";
import multer from "multer";
import fs from "fs";
import path from "path";
import crypto from "crypto";
import { execFile } from "child_process";
import { promisify } from "util";

import makeWASocket, {
  DisconnectReason,
  useMultiFileAuthState,
  fetchLatestBaileysVersion
} from "@whiskeysockets/baileys";

import P from "pino";

const exec = promisify(execFile);

const app = express();

const ROOT = process.cwd();
const DATA_DIR = path.join(ROOT, "data");
const UPLOAD_DIR = path.join(DATA_DIR, "uploads");
const OUTPUT_DIR = path.join(DATA_DIR, "output");
const AUTH_DIR = path.join(DATA_DIR, "auth");

for (const dir of [
  DATA_DIR,
  UPLOAD_DIR,
  OUTPUT_DIR,
  AUTH_DIR
]) {
  fs.mkdirSync(dir, { recursive: true });
}

const PORT = Number(process.env.PORT || 3000);
const MAX_FILE_MB = Number(process.env.MAX_FILE_MB || 100);
const CLAIM_TTL_MINUTES = Number(
  process.env.CLAIM_TTL_MINUTES || 30
);

const MAX_FILE_SIZE =
  MAX_FILE_MB * 1024 * 1024;

/*
|--------------------------------------------------------------------------
| CLAIM STORAGE
|--------------------------------------------------------------------------
*/

const claims = new Map();

/*
|--------------------------------------------------------------------------
| MULTER
|--------------------------------------------------------------------------
*/

const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, UPLOAD_DIR);
  },

  filename: (req, file, cb) => {
    const randomName =
      crypto.randomBytes(12).toString("hex");

    const ext =
      path.extname(file.originalname || "") ||
      ".mp4";

    cb(null, randomName + ext);
  }
});

const upload = multer({
  storage,

  limits: {
    fileSize: MAX_FILE_SIZE
  },

  fileFilter: (req, file, cb) => {
    const isVideo =
      file.mimetype &&
      file.mimetype.startsWith("video/");

    if (!isVideo) {
      return cb(
        new Error("File harus berupa video.")
      );
    }

    cb(null, true);
  }
});

/*
|--------------------------------------------------------------------------
| STATIC WEBSITE
|--------------------------------------------------------------------------
*/

app.use(
  express.static(
    path.join(ROOT, "web")
  )
);

/*
|--------------------------------------------------------------------------
| HEALTH CHECK
|--------------------------------------------------------------------------
*/

app.get("/api/health", (req, res) => {
  res.json({
    ok: true,
    service: "WA HD Claim",
    time: new Date().toISOString()
  });
});

/*
|--------------------------------------------------------------------------
| UPLOAD + FFMPEG
|--------------------------------------------------------------------------
*/

app.post(
  "/api/upload",
  upload.single("video"),
  async (req, res) => {

    if (!req.file) {
      return res.status(400).json({
        ok: false,
        message: "Video tidak ditemukan."
      });
    }

    const inputFile = req.file.path;

    const claimId =
      crypto
        .randomBytes(4)
        .toString("hex")
        .toUpperCase();

    const outputFile =
      path.join(
        OUTPUT_DIR,
        `${claimId}.mp4`
      );

    try {

      console.log(
        `[UPLOAD] ${req.file.originalname}`
      );

      console.log(
        `[FFMPEG] Processing ${claimId}`
      );

      await exec(
        "ffmpeg",
        [
          "-y",

          "-i",
          inputFile,

          "-vf",
          "scale='min(1080,iw)':'min(1920,ih)':force_original_aspect_ratio=decrease,pad=ceil(iw/2)*2:ceil(ih/2)*2",

          "-c:v",
          "libx264",

          "-preset",
          "veryfast",

          "-crf",
          "20",

          "-pix_fmt",
          "yuv420p",

          "-movflags",
          "+faststart",

          "-c:a",
          "aac",

          "-b:a",
          "128k",

          outputFile
        ],
        {
          maxBuffer: 1024 * 1024 * 10
        }
      );

      fs.rmSync(
        inputFile,
        { force: true }
      );

      claims.set(
        claimId,
        {
          file: outputFile,
          createdAt: Date.now(),
          used: false
        }
      );

      console.log(
        `[CLAIM] .claim${claimId}`
      );

      return res.json({
        ok: true,

        claim:
          `.claim${claimId}`,

        id: claimId,

        downloadUrl:
          `/api/download/${claimId}`
      });

    } catch (error) {

      console.error(
        "[FFMPEG ERROR]",
        error
      );

      fs.rmSync(
        inputFile,
        { force: true }
      );

      fs.rmSync(
        outputFile,
        { force: true }
      );

      return res.status(500).json({
        ok: false,
        message:
          "Gagal memproses video. Pastikan FFmpeg tersedia."
      });
    }
  }
);

/*
|--------------------------------------------------------------------------
| DOWNLOAD
|--------------------------------------------------------------------------
*/

app.get(
  "/api/download/:id",
  (req, res) => {

    const id =
      String(req.params.id)
        .toUpperCase();

    const claim =
      claims.get(id);

    if (
      !claim ||
      !fs.existsSync(claim.file)
    ) {
      return res.status(404).send(
        "Claim tidak ditemukan atau sudah expired."
      );
    }

    return res.download(
      claim.file,
      `wa-hd-${id}.mp4`
    );
  }
);

/*
|--------------------------------------------------------------------------
| WHATSAPP
|--------------------------------------------------------------------------
*/

let sock = null;
let waState = "offline";

let reconnectTimer = null;

async function startWhatsApp() {

  if (sock) {
    return;
  }

  waState = "starting";

  console.log(
    "[WA] Starting WhatsApp..."
  );

  try {

    const {
      state,
      saveCreds
    } =
      await useMultiFileAuthState(
        AUTH_DIR
      );

    const {
      version
    } =
      await fetchLatestBaileysVersion();

    sock =
      makeWASocket({
        version,

        auth: state,

        logger:
          P({
            level: "silent"
          }),

        printQRInTerminal: true,

        browser: [
          "WA HD Claim",
          "Chrome",
          "1.0.0"
        ]
      });

    sock.ev.on(
      "creds.update",
      saveCreds
    );

    sock.ev.on(
      "connection.update",
      update => {

        const {
          connection,
          lastDisconnect
        } = update;

        if (connection === "open") {

          waState = "connected";

          console.log(
            "[WA] Connected!"
          );
        }

        if (connection === "close") {

          console.log(
            "[WA] Connection closed."
          );

          sock = null;
          waState = "offline";

          const statusCode =
            lastDisconnect
              ?.error
              ?.output
              ?.statusCode;

          if (
            statusCode !==
            DisconnectReason.loggedOut
          ) {

            if (!reconnectTimer) {

              reconnectTimer =
                setTimeout(
                  () => {

                    reconnectTimer =
                      null;

                    startWhatsApp()
                      .catch(console.error);

                  },
                  5000
                );
            }
          }
        }
      }
    );

    /*
    |--------------------------------------------------------------------------
    | MESSAGE HANDLER
    |--------------------------------------------------------------------------
    */

    sock.ev.on(
      "messages.upsert",
      async ({ messages }) => {

        try {

          const message =
            messages?.[0];

          if (
            !message ||
            !message.message ||
            message.key.fromMe
          ) {
            return;
          }

          const text =
            message.message.conversation ||
            message.message
              ?.extendedTextMessage
              ?.text ||
            "";

          const command =
            text.trim();

          const match =
            command.match(
              /^\.claim([A-F0-9]{8})$/i
            );

          if (!match) {
            return;
          }

          const id =
            match[1].toUpperCase();

          const claim =
            claims.get(id);

          const jid =
            message.key.remoteJid;

          console.log(
            `[CLAIM REQUEST] ${id}`
          );

          /*
          |--------------------------------------------------------------------------
          | CLAIM TIDAK ADA
          |--------------------------------------------------------------------------
          */

          if (
            !claim ||
            claim.used ||
            !fs.existsSync(claim.file)
          ) {

            await sock.sendMessage(
              jid,
              {
                text:
                  "❌ Claim tidak ditemukan, sudah digunakan, atau sudah expired."
              }
            );

            return;
          }

          /*
          |--------------------------------------------------------------------------
          | KIRIM VIDEO
          |--------------------------------------------------------------------------
          */

          try {

            claim.used = true;

            await sock.sendMessage(
              jid,
              {
                video: {
                  url: claim.file
                },

                mimetype:
                  "video/mp4",

                fileName:
                  `wa-hd-${id}.mp4`,

                caption:
                  "✅ Video berhasil diproses oleh WA HD Claim."
              }
            );

            console.log(
              `[WA] Video sent: ${id}`
            );

            fs.rmSync(
              claim.file,
              {
                force: true
              }
            );

            claims.delete(id);

          } catch (sendError) {

            console.error(
              "[WA SEND ERROR]",
              sendError
            );

            claim.used = false;

            await sock.sendMessage(
              jid,
              {
                text:
                  "❌ Gagal mengirim video. Silakan coba claim lagi."
              }
            );
          }

        } catch (error) {

          console.error(
            "[MESSAGE ERROR]",
            error
          );
        }
      }
    );

  } catch (error) {

    console.error(
      "[WA START ERROR]",
      error
    );

    sock = null;
    waState = "offline";

    throw error;
  }
}

/*
|--------------------------------------------------------------------------
| ACTIVATE WHATSAPP
|--------------------------------------------------------------------------
*/

app.post(
  "/api/whatsapp/start",
  async (req, res) => {

    try {

      await startWhatsApp();

      return res.json({
        ok: true,
        state: waState
      });

    } catch (error) {

      console.error(error);

      return res.status(500).json({
        ok: false,
        message:
          "Gagal mengaktifkan WhatsApp."
      });
    }
  }
);

/*
|--------------------------------------------------------------------------
| WHATSAPP STATUS
|--------------------------------------------------------------------------
*/

app.get(
  "/api/whatsapp/status",
  (req, res) => {

    res.json({
      ok: true,
      state: waState
    });
  }
);

/*
|--------------------------------------------------------------------------
| ROOT
|--------------------------------------------------------------------------
*/

app.get(
  "/",
  (req, res) => {

    res.sendFile(
      path.join(
        ROOT,
        "web",
        "index.html"
      )
    );
  }
);

/*
|--------------------------------------------------------------------------
| MULTER ERROR
|--------------------------------------------------------------------------
*/

app.use(
  (error, req, res, next) => {

    if (
      error instanceof multer.MulterError
    ) {

      if (
        error.code ===
        "LIMIT_FILE_SIZE"
      ) {

        return res.status(413).json({
          ok: false,
          message:
            `Ukuran video maksimal ${MAX_FILE_MB} MB.`
        });
      }
    }

    console.error(error);

    return res.status(500).json({
      ok: false,
      message:
        error.message ||
        "Terjadi kesalahan server."
    });
  }
);

/*
|--------------------------------------------------------------------------
| CLEANUP CLAIM EXPIRED
|--------------------------------------------------------------------------
*/

setInterval(
  () => {

    const expireBefore =
      Date.now() -
      CLAIM_TTL_MINUTES *
      60 *
      1000;

    for (
      const [id, claim]
      of claims
    ) {

      if (
        claim.createdAt <
        expireBefore
      ) {

        console.log(
          `[CLEANUP] ${id}`
        );

        fs.rmSync(
          claim.file,
          {
            force: true
          }
        );

        claims.delete(id);
      }
    }

  },
  60 * 1000
);

/*
|--------------------------------------------------------------------------
| START SERVER
|--------------------------------------------------------------------------
*/

app.listen(
  PORT,
  "0.0.0.0",
  () => {

    console.log(
      "================================="
    );

    console.log(
      "       WA HD CLAIM SERVER"
    );

    console.log(
      "================================="
    );

    console.log(
      `Server running on port ${PORT}`
    );

    console.log(
      `Max upload: ${MAX_FILE_MB} MB`
    );

    console.log(
      `Claim TTL: ${CLAIM_TTL_MINUTES} minutes`
    );

  }
);

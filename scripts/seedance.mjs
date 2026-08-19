#!/usr/bin/env node

import { createWriteStream } from "node:fs";
import { readFile } from "node:fs/promises";
import { extname } from "node:path";
import { pipeline } from "node:stream/promises";

const BASE_URL = process.env.OPENLUX_BASE_URL ?? "https://api.openlux.ai";
const DEFAULT_MODEL = "doubao-seedance-2-0-260128";

function printUsage() {
  console.log(`Usage:
  npm run seedance -- create "prompt" [options]
  npm run seedance -- get <task-id> [--query-api api-v3|volc-v1]
  npm run seedance -- wait <task-id> [options]

Environment:
  OPENLUX_API_KEY       Required API key
  OPENLUX_BASE_URL      Optional, defaults to ${BASE_URL}

Create options:
  --model <model>       Defaults to ${DEFAULT_MODEL}
  --resolution <value>  Defaults to 720p
  --ratio <value>       Defaults to 16:9
  --duration <seconds>  Defaults to 5
  --image <path>        Local first-frame image
  --image-url <url>     Public first-frame image URL
  --last-image-url <url> Public last-frame image URL
  --seed <number>
  --audio <true|false>  Defaults to true
  --watermark <bool>    Defaults to false
  --create-api <value>  api-v3 (default) or volc-v1
  --wait                Poll until completion
  --download <path>     Poll and download the generated video

Wait options:
  --interval <seconds>  Defaults to 10
  --timeout <seconds>   Defaults to 1800
  --download <path>
  --query-api <value>   api-v3 (default) or volc-v1`);
}

function parseArgs(args) {
  const positional = [];
  const options = {};

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (!arg.startsWith("--")) {
      positional.push(arg);
      continue;
    }

    const key = arg.slice(2);
    if (key === "wait") {
      options.wait = true;
      continue;
    }

    const value = args[index + 1];
    if (value === undefined || value.startsWith("--")) {
      throw new Error(`Missing value for --${key}`);
    }
    options[key] = value;
    index += 1;
  }

  return { positional, options };
}

function parseBoolean(value, name) {
  if (value === "true") return true;
  if (value === "false") return false;
  throw new Error(`--${name} must be true or false`);
}

function requireApiKey() {
  const apiKey = process.env.OPENLUX_API_KEY;
  if (!apiKey) {
    throw new Error("OPENLUX_API_KEY is required");
  }
  return apiKey;
}

async function request(path, init = {}) {
  const response = await fetch(`${BASE_URL}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${requireApiKey()}`,
      ...(init.body ? { "Content-Type": "application/json" } : {}),
      ...init.headers,
    },
  });

  const text = await response.text();
  let body;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    throw new Error(`OpenLux returned non-JSON (${response.status}): ${text}`);
  }

  if (!response.ok) {
    const message = body?.error?.message ?? JSON.stringify(body);
    throw new Error(`OpenLux request failed (${response.status}): ${message}`);
  }

  return body;
}

function buildParameters(options) {
  const resolution = options.resolution ?? "720p";
  const ratio = options.ratio ?? "16:9";
  const duration = Number(options.duration ?? 5);
  const audio = parseBoolean(options.audio ?? "true", "audio");
  const watermark = parseBoolean(options.watermark ?? "false", "watermark");

  if (!Number.isInteger(duration) || (duration !== -1 && (duration < 4 || duration > 15))) {
    throw new Error("--duration must be an integer from 4 to 15, or -1");
  }

  const parameters = {
    resolution,
    ratio,
    duration,
    generate_audio: audio,
    watermark,
  };

  if (options.seed !== undefined) {
    const seed = Number(options.seed);
    if (!Number.isInteger(seed)) {
      throw new Error("--seed must be an integer");
    }
    parameters.seed = seed;
  }

  return parameters;
}

async function imageContent(imagePath) {
  const mimeTypes = {
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".png": "image/png",
    ".webp": "image/webp",
  };
  const mimeType = mimeTypes[extname(imagePath).toLowerCase()];
  if (!mimeType) {
    throw new Error("--image must be a PNG, JPEG, or WebP file");
  }

  const data = await readFile(imagePath);
  return {
    type: "image_url",
    image_url: { url: `data:${mimeType};base64,${data.toString("base64")}` },
  };
}

async function createTask(prompt, options) {
  if (!prompt) throw new Error("A prompt is required");
  if (options.image && options["image-url"]) {
    throw new Error("--image and --image-url cannot be used together");
  }
  if (options["last-image-url"] && !options["image-url"]) {
    throw new Error("--last-image-url requires --image-url");
  }

  const content = [{ type: "text", text: prompt }];
  if (options.image) {
    content.push(await imageContent(options.image));
  } else if (options["image-url"]) {
    content.push({
      type: "image_url",
      image_url: { url: options["image-url"] },
      ...(options["last-image-url"] ? { role: "first_frame" } : {}),
    });
    if (options["last-image-url"]) {
      content.push({
        type: "image_url",
        image_url: { url: options["last-image-url"] },
        role: "last_frame",
      });
    }
  }

  const createApi = options["create-api"] ?? "api-v3";
  const paths = {
    "api-v3": "/api/v3/contents/generations/tasks",
    "volc-v1": "/volc/v1/contents/generations/tasks",
  };
  const path = paths[createApi];
  if (!path) {
    throw new Error("--create-api must be api-v3 or volc-v1");
  }

  return request(path, {
    method: "POST",
    body: JSON.stringify({
      model: options.model ?? DEFAULT_MODEL,
      content,
      ...buildParameters(options),
    }),
  });
}

async function getTask(taskId, queryApi = "api-v3") {
  if (!taskId) throw new Error("A task ID is required");
  const encodedId = encodeURIComponent(taskId);

  if (queryApi === "api-v3") {
    return request(`/api/v3/contents/generations/tasks/${encodedId}`);
  }
  if (queryApi === "volc-v1") {
    return request(`/volc/v1/contents/generations/tasks/${encodedId}`);
  }
  throw new Error("--query-api must be api-v3 or volc-v1");
}

function taskState(task) {
  return task?.status ?? task?.data?.status;
}

function isSucceeded(task) {
  return ["succeeded", "succeed"].includes(taskState(task));
}

function isFailed(task) {
  return ["failed", "error", "cancelled", "canceled", "expired"].includes(
    taskState(task),
  );
}

async function downloadVideo(url, outputPath) {
  const response = await fetch(url);
  if (!response.ok || !response.body) {
    throw new Error(`Video download failed (${response.status})`);
  }
  await pipeline(response.body, createWriteStream(outputPath));
}

async function waitForTask(taskId, options) {
  const intervalSeconds = Number(options.interval ?? 10);
  const timeoutSeconds = Number(options.timeout ?? 1800);
  const queryApi = options["query-api"] ?? "api-v3";

  if (!Number.isFinite(intervalSeconds) || intervalSeconds <= 0) {
    throw new Error("--interval must be a positive number");
  }
  if (!Number.isFinite(timeoutSeconds) || timeoutSeconds <= 0) {
    throw new Error("--timeout must be a positive number");
  }

  const deadline = Date.now() + timeoutSeconds * 1000;
  while (Date.now() < deadline) {
    const task = await getTask(taskId, queryApi);
    console.log(JSON.stringify(task, null, 2));

    if (isSucceeded(task)) {
      const videoUrl = task?.content?.video_url;
      if (options.download) {
        if (!videoUrl) {
          throw new Error(
            "Task succeeded but this response has no video URL; use --query-api api-v3",
          );
        }
        await downloadVideo(videoUrl, options.download);
        console.log(`Downloaded video to ${options.download}`);
      }
      return task;
    }
    if (isFailed(task)) {
      throw new Error(`Task ended with status: ${taskState(task)}`);
    }

    await new Promise((resolve) => setTimeout(resolve, intervalSeconds * 1000));
  }

  throw new Error(`Timed out waiting for task ${taskId}`);
}

async function main() {
  const [command, ...args] = process.argv.slice(2);
  if (!command || command === "--help" || command === "-h") {
    printUsage();
    return;
  }

  const { positional, options } = parseArgs(args);

  if (command === "create") {
    const task = await createTask(positional.join(" "), options);
    console.log(JSON.stringify(task, null, 2));
    if (options.wait || options.download) {
      await waitForTask(task.id, options);
    }
    return;
  }

  if (command === "get") {
    const task = await getTask(positional[0], options["query-api"]);
    console.log(JSON.stringify(task, null, 2));
    return;
  }

  if (command === "wait") {
    await waitForTask(positional[0], options);
    return;
  }

  throw new Error(`Unknown command: ${command}`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});

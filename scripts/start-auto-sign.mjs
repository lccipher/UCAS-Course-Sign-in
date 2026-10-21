#!/usr/bin/env node

import { spawn } from "node:child_process";
import { createServer } from "node:net";

const npmCommand = process.platform === "win32" ? "npm.cmd" : "npm";
const mode = process.argv[2] === "dev" ? "dev" : "start";
const requestedPort = Number.parseInt(process.env.PORT ?? "3000", 10);
const children = new Set();
let shuttingDown = false;

function canListen(port) {
	return new Promise((resolve) => {
		const server = createServer();
		server.once("error", () => resolve(false));
		server.once("listening", () => server.close(() => resolve(true)));
		server.listen(port, "127.0.0.1");
	});
}

async function findAvailablePort(startPort) {
	for (let port = startPort; port < startPort + 20; port += 1) {
		if (await canListen(port)) {
			return port;
		}
	}
	throw new Error(`No available port found from ${startPort} to ${startPort + 19}`);
}

async function waitForServer(baseUrl, timeoutMs = 60000) {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		try {
			const response = await fetch(baseUrl, { cache: "no-store" });
			if (response.ok) {
				return;
			}
		} catch {}
		await new Promise((resolve) => setTimeout(resolve, 500));
	}
	throw new Error(`Next.js did not become ready within ${timeoutMs / 1000}s`);
}

function trackChild(child) {
	children.add(child);
	child.on("error", (error) => {
		console.error(`Failed to start child process: ${error.message}`);
		shutdown(1);
	});
	child.on("exit", (code, signal) => {
		children.delete(child);
		if (!shuttingDown) {
			console.error(`Child process stopped unexpectedly: code=${code ?? "null"}, signal=${signal ?? "null"}`);
			shutdown(code && code !== 0 ? code : 1);
		}
	});
	return child;
}

function shutdown(exitCode = 0) {
	if (shuttingDown) {
		return;
	}
	shuttingDown = true;
	for (const child of children) {
		if (!child.killed) {
			child.kill("SIGTERM");
		}
	}
	setTimeout(() => process.exit(exitCode), 500);
}

process.on("SIGINT", () => shutdown(0));
process.on("SIGTERM", () => shutdown(0));

try {
	const port = await findAvailablePort(Number.isFinite(requestedPort) ? requestedPort : 3000);
	const baseUrl = `http://127.0.0.1:${port}`;
	console.log(`Starting Next.js (${mode}) at ${baseUrl}`);
	trackChild(spawn(npmCommand, ["run", mode, "--", "-p", String(port)], { stdio: "inherit" }));
	await waitForServer(baseUrl);
	console.log(`Next.js is ready; starting auto-sign scheduler for ${baseUrl}`);
	trackChild(
		spawn(npmCommand, ["run", "auto-sign", "--", "--base-url", baseUrl], { stdio: "inherit" })
	);
} catch (error) {
	console.error(`Unable to start auto-sign services: ${error.message}`);
	shutdown(1);
}

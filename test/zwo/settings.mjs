#!/usr/bin/env node
/**
 * Write the built-in Alpaca server's settings with authorization on.
 *
 * The server keeps them as an XML list of key/value pairs and stores the password as base64 of a
 * 16-byte salt followed by 20 bytes of PBKDF2-SHA1 (1000 iterations) — the same thing its settings
 * page writes.
 *
 * Usage: node settings.mjs <username> <password> <path>
 */

import { pbkdf2Sync, randomBytes } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

const [username, password, path] = process.argv.slice(2);
if (!username || !password || !path) {
	process.stderr.write("usage: settings.mjs <username> <password> <path>\n");
	process.exit(2);
}

const salt = randomBytes(16);
const key = pbkdf2Sync(password, salt, 1000, 20, "sha1");
const stored = Buffer.concat([salt, key]).toString("base64");

const pair = (name, value) =>
	`  <SettingsPair>\n    <Key>${name}</Key>\n    <Value>${value}</Value>\n  </SettingsPair>`;

const xml = [
	'<?xml version="1.0" encoding="utf-8"?>',
	'<ArrayOfSettingsPair xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xmlns:xsd="http://www.w3.org/2001/XMLSchema">',
	pair("UseAuth", "True"),
	pair("UserName", username),
	pair("Password", stored),
	"</ArrayOfSettingsPair>",
	"",
].join("\n");

mkdirSync(dirname(path), { recursive: true });
writeFileSync(path, xml);

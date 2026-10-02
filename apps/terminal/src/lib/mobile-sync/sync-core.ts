import {
	createMobileAgentName,
	MOBILE_AGENT_NAME_BASE,
	MOBILE_AGENT_VALIDITY_MS,
} from "@hypeterminal/hl-react/signing/mobile-agent";
import { type Address, getAddress, type Hex, isAddress } from "viem";
import { privateKeyToAccount } from "viem/accounts";

export const MOBILE_SYNC_FRAGMENT_KEY = "ht-mobile-sync";
export const MOBILE_SYNC_ROUTE_PATH = "/mobile-agent-sync";
/**
 * How long a link + pairing code can be used. Deliberately short: the code alone
 * unlocks trading, and a fully offline handoff cannot be made *provably*
 * single-use (there is no server to burn the code on), so the practical defence is
 * the smallest window that still lets a human scan a QR and type 16 characters.
 */
export const MOBILE_SYNC_PAYLOAD_TTL_MS = 3 * 60 * 1000;
export const MOBILE_SYNC_CLOCK_SKEW_MS = 60 * 1000;
export const MOBILE_SYNC_KDF_ITERATIONS = 310000;
export { createMobileAgentName, MOBILE_AGENT_NAME_BASE, MOBILE_AGENT_VALIDITY_MS };

const MOBILE_SYNC_ENVELOPE_TYPE = "hypeterminal.mobile-agent-sync";
const MOBILE_SYNC_PLAINTEXT_TYPE = "hypeterminal.mobile-agent";
const PAIRING_CODE_BYTES = 8;
const SYNC_ID_BYTES = 16;
const SALT_BYTES = 16;
const AES_GCM_IV_BYTES = 12;
const AES_GCM_TAG_LENGTH = 128;
const AES_GCM_KEY_LENGTH = 256;
const HEX_PRIVATE_KEY_RE = /^0x[0-9a-fA-F]{64}$/;
const HEX_PAIRING_CODE_RE = /^[0-9A-F]{16}$/;

export type HyperliquidEnvName = "Mainnet" | "Testnet";

export type MobileSyncErrorCode =
	| "invalid_pairing_code"
	| "missing_sync_fragment"
	| "sync_payload_in_query"
	| "sync_payload_in_path"
	| "unknown_fragment_key"
	| "invalid_payload_encoding"
	| "invalid_envelope"
	| "expired_payload"
	| "decrypt_failed"
	| "invalid_plaintext"
	| "origin_mismatch"
	| "env_mismatch"
	| "account_mismatch"
	| "agent_key_mismatch";

export class MobileSyncError extends Error {
	readonly code: MobileSyncErrorCode;

	constructor(code: MobileSyncErrorCode) {
		super(getMobileSyncErrorMessage(code));
		this.name = "MobileSyncError";
		this.code = code;
	}
}

export interface MobileSyncEnvelope {
	v: 1;
	type: typeof MOBILE_SYNC_ENVELOPE_TYPE;
	syncId: string;
	createdAtMs: number;
	expiresAtMs: number;
	kdf: {
		name: "PBKDF2";
		hash: "SHA-256";
		iterations: typeof MOBILE_SYNC_KDF_ITERATIONS;
		salt: string;
	};
	cipher: {
		name: "AES-GCM";
		length: typeof AES_GCM_KEY_LENGTH;
		iv: string;
		tagLength: typeof AES_GCM_TAG_LENGTH;
	};
	ciphertext: string;
}

export interface MobileAgentSyncPlaintext {
	v: 1;
	type: typeof MOBILE_SYNC_PLAINTEXT_TYPE;
	syncId: string;
	issuerOrigin: string;
	env: HyperliquidEnvName;
	userAddress: Address;
	agentAddress: Address;
	agentPrivateKey: Hex;
	agentNameBase: typeof MOBILE_AGENT_NAME_BASE;
	agentName: string;
	agentValidUntilMs: number;
	createdAtMs: number;
	expiresAtMs: number;
	/** Set by preview builds (no on-chain agent approval exists for them). */
	preview?: boolean;
}

export interface ImportedMobileAgent {
	env: HyperliquidEnvName;
	userAddress: Address;
	agentAddress: Address;
	agentPrivateKey: Hex;
	agentNameBase: typeof MOBILE_AGENT_NAME_BASE;
	agentName: string;
	agentValidUntilMs: number;
	importedAtMs: number;
	preview?: boolean;
	syncId: string;
}

export interface CreateMobileAgentSyncUrlInput {
	appOrigin: string;
	/** Preview builds never register the agent on Hyperliquid (no wallet signature);
	 * the phone accepts this embedded marker instead of the on-chain registry. */
	preview?: boolean;
	env: HyperliquidEnvName;
	userAddress: string;
	agentPrivateKey: string;
	agentName?: string;
	agentValidUntilMs?: number;
	nowMs?: number;
	routePath?: string;
}

export interface CreateMobileAgentSyncUrlResult {
	url: string;
	pairingCode: string;
	envelope: MobileSyncEnvelope;
	agentAddress: Address;
	agentName: string;
	agentValidUntilMs: number;
	expiresAtMs: number;
	syncId: string;
}

export interface DecryptMobileAgentSyncOptions {
	nowMs?: number;
	currentOrigin?: string;
	expectedUserAddress?: string;
	expectedEnv?: HyperliquidEnvName;
	allowedOrigins?: string[];
}

export interface MobileSyncLocationLike {
	href: string;
	pathname: string;
	search: string;
	hash: string;
}

export interface MobileSyncHistoryLike {
	replaceState(data: unknown, unused: string, url?: string | URL | null): void;
}

type JsonRecord = Record<string, unknown>;

export async function createMobileAgentSyncUrl(
	input: CreateMobileAgentSyncUrlInput,
): Promise<CreateMobileAgentSyncUrlResult> {
	const nowMs = input.nowMs ?? Date.now();
	const expiresAtMs = nowMs + MOBILE_SYNC_PAYLOAD_TTL_MS;
	const appOrigin = normalizeOrigin(input.appOrigin);
	const userAddress = normalizeAddress(input.userAddress, "invalid_plaintext");
	const agentPrivateKey = normalizePrivateKey(input.agentPrivateKey);
	const agentAddress = privateKeyToAccount(agentPrivateKey).address;
	const agentValidUntilMs = input.agentValidUntilMs ?? nowMs + MOBILE_AGENT_VALIDITY_MS;
	const agentName = input.agentName ?? createMobileAgentName(agentValidUntilMs);
	assertValidAgentApproval(agentName, agentValidUntilMs, nowMs);
	const pairingCode = createPairingCode();
	const crypto = getCrypto();

	const envelopeWithoutCiphertext = createEnvelopeWithoutCiphertext(nowMs, expiresAtMs, crypto);
	const plaintext: MobileAgentSyncPlaintext = {
		v: 1,
		...(input.preview ? { preview: true } : {}),
		type: MOBILE_SYNC_PLAINTEXT_TYPE,
		syncId: envelopeWithoutCiphertext.syncId,
		issuerOrigin: appOrigin,
		env: input.env,
		userAddress,
		agentAddress,
		agentPrivateKey,
		agentNameBase: MOBILE_AGENT_NAME_BASE,
		agentName,
		agentValidUntilMs,
		createdAtMs: nowMs,
		expiresAtMs,
	};

	const key = await deriveMobileSyncKey(pairingCode, envelopeWithoutCiphertext, crypto);
	const ciphertext = await crypto.subtle.encrypt(
		{
			name: "AES-GCM",
			iv: toArrayBuffer(base64UrlToBytes(envelopeWithoutCiphertext.cipher.iv)),
			additionalData: toArrayBuffer(createEnvelopeAdditionalData(envelopeWithoutCiphertext)),
			tagLength: AES_GCM_TAG_LENGTH,
		},
		key,
		toArrayBuffer(utf8Encode(canonicalJson(plaintext))),
	);
	const envelope: MobileSyncEnvelope = {
		...envelopeWithoutCiphertext,
		ciphertext: bytesToBase64Url(new Uint8Array(ciphertext)),
	};
	const url = buildMobileSyncUrl(appOrigin, input.routePath ?? MOBILE_SYNC_ROUTE_PATH, envelope);

	return {
		url,
		pairingCode,
		envelope,
		agentAddress,
		agentName,
		agentValidUntilMs,
		expiresAtMs,
		syncId: envelope.syncId,
	};
}

export function normalizePairingCode(pairingCode: string): string {
	const normalized = pairingCode.toUpperCase().replace(/[\s-]/g, "");
	if (!HEX_PAIRING_CODE_RE.test(normalized)) {
		throw new MobileSyncError("invalid_pairing_code");
	}
	return normalized;
}

export function createPairingCode(crypto: Crypto = getCrypto()): string {
	const bytes = new Uint8Array(PAIRING_CODE_BYTES);
	crypto.getRandomValues(bytes);
	const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0").toUpperCase()).join("");
	return `${hex.slice(0, 4)}-${hex.slice(4, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}`;
}

export function parseMobileSyncUrl(urlInput: string | URL): MobileSyncEnvelope {
	const url = typeof urlInput === "string" ? new URL(urlInput) : urlInput;

	if (url.searchParams.has(MOBILE_SYNC_FRAGMENT_KEY)) {
		throw new MobileSyncError("sync_payload_in_query");
	}
	if (decodeURIComponent(url.pathname).includes(MOBILE_SYNC_FRAGMENT_KEY)) {
		throw new MobileSyncError("sync_payload_in_path");
	}

	const rawHash = url.hash.startsWith("#") ? url.hash.slice(1) : url.hash;
	if (!rawHash) {
		throw new MobileSyncError("missing_sync_fragment");
	}

	const params = new URLSearchParams(rawHash);
	const entries = Array.from(params.entries());
	if (entries.length !== 1) {
		throw new MobileSyncError(entries.length === 0 ? "missing_sync_fragment" : "unknown_fragment_key");
	}

	const [key, encoded] = entries[0] ?? [];
	if (key !== MOBILE_SYNC_FRAGMENT_KEY || !encoded) {
		throw new MobileSyncError(key ? "unknown_fragment_key" : "missing_sync_fragment");
	}

	return decodeMobileSyncEnvelope(encoded);
}

export function readAndClearMobileSyncEnvelope(
	location: MobileSyncLocationLike = window.location,
	history: MobileSyncHistoryLike = window.history,
): MobileSyncEnvelope {
	const href = location.href;
	history.replaceState(null, "", getMobileSyncCleanUrl(location));
	return parseMobileSyncUrl(href);
}

export function getMobileSyncCleanUrl(location: Pick<MobileSyncLocationLike, "pathname" | "search">): string {
	return `${location.pathname}${location.search}`;
}

export async function decryptMobileAgentSyncEnvelope(
	envelope: MobileSyncEnvelope,
	pairingCode: string,
	options: DecryptMobileAgentSyncOptions = {},
): Promise<ImportedMobileAgent> {
	const validEnvelope = validateMobileSyncEnvelope(envelope);
	const nowMs = options.nowMs ?? Date.now();
	assertEnvelopeNotExpired(validEnvelope, nowMs);

	let plaintextBytes: ArrayBuffer;
	try {
		const crypto = getCrypto();
		const envelopeWithoutCiphertext = removeCiphertext(validEnvelope);
		const key = await deriveMobileSyncKey(pairingCode, envelopeWithoutCiphertext, crypto);
		plaintextBytes = await crypto.subtle.decrypt(
			{
				name: "AES-GCM",
				iv: toArrayBuffer(base64UrlToBytes(validEnvelope.cipher.iv)),
				additionalData: toArrayBuffer(createEnvelopeAdditionalData(envelopeWithoutCiphertext)),
				tagLength: AES_GCM_TAG_LENGTH,
			},
			key,
			toArrayBuffer(base64UrlToBytes(validEnvelope.ciphertext)),
		);
	} catch (error) {
		if (error instanceof MobileSyncError) throw error;
		throw new MobileSyncError("decrypt_failed");
	}

	let plaintext: unknown;
	try {
		plaintext = JSON.parse(utf8Decode(new Uint8Array(plaintextBytes)));
	} catch {
		throw new MobileSyncError("invalid_plaintext");
	}

	return validateMobileAgentSyncPlaintext(plaintext, validEnvelope, {
		...options,
		nowMs,
	});
}

export async function importMobileAgentSyncUrl(
	urlInput: string | URL,
	pairingCode: string,
	options: DecryptMobileAgentSyncOptions = {},
): Promise<ImportedMobileAgent> {
	return decryptMobileAgentSyncEnvelope(parseMobileSyncUrl(urlInput), pairingCode, options);
}

export function validateMobileAgentSyncPlaintext(
	plaintextInput: unknown,
	envelope: MobileSyncEnvelope,
	options: DecryptMobileAgentSyncOptions = {},
): ImportedMobileAgent {
	const plaintext = asRecord(plaintextInput, "invalid_plaintext");
	const nowMs = options.nowMs ?? Date.now();

	if (plaintext.v !== 1 || plaintext.type !== MOBILE_SYNC_PLAINTEXT_TYPE) {
		throw new MobileSyncError("invalid_plaintext");
	}
	if (plaintext.syncId !== envelope.syncId) {
		throw new MobileSyncError("invalid_plaintext");
	}
	if (plaintext.createdAtMs !== envelope.createdAtMs || plaintext.expiresAtMs !== envelope.expiresAtMs) {
		throw new MobileSyncError("invalid_plaintext");
	}

	const issuerOrigin = asString(plaintext.issuerOrigin, "invalid_plaintext");
	validateOrigin(issuerOrigin, options.currentOrigin, options.allowedOrigins);

	const env = plaintext.env;
	if (env !== "Mainnet" && env !== "Testnet") {
		throw new MobileSyncError("invalid_plaintext");
	}
	if (options.expectedEnv && env !== options.expectedEnv) {
		throw new MobileSyncError("env_mismatch");
	}

	const userAddress = normalizeAddress(plaintext.userAddress, "invalid_plaintext");
	if (
		options.expectedUserAddress &&
		userAddress !== normalizeAddress(options.expectedUserAddress, "account_mismatch")
	) {
		throw new MobileSyncError("account_mismatch");
	}

	const agentAddress = normalizeAddress(plaintext.agentAddress, "invalid_plaintext");
	const agentPrivateKey = normalizePrivateKey(plaintext.agentPrivateKey);
	const derivedAgentAddress = normalizeAddress(privateKeyToAccount(agentPrivateKey).address, "agent_key_mismatch");
	if (derivedAgentAddress !== agentAddress) {
		throw new MobileSyncError("agent_key_mismatch");
	}

	const agentValidUntilMs = asSafeInteger(plaintext.agentValidUntilMs, "invalid_plaintext");
	if (agentValidUntilMs <= nowMs) {
		throw new MobileSyncError("invalid_plaintext");
	}
	if (agentValidUntilMs > envelope.createdAtMs + MOBILE_AGENT_VALIDITY_MS + MOBILE_SYNC_PAYLOAD_TTL_MS) {
		throw new MobileSyncError("invalid_plaintext");
	}

	const agentNameBase = plaintext.agentNameBase;
	if (agentNameBase !== MOBILE_AGENT_NAME_BASE) {
		throw new MobileSyncError("invalid_plaintext");
	}
	const agentName = asString(plaintext.agentName, "invalid_plaintext");
	if (agentName !== createMobileAgentName(agentValidUntilMs)) {
		throw new MobileSyncError("invalid_plaintext");
	}

	return {
		env,
		userAddress,
		agentAddress,
		agentPrivateKey,
		agentNameBase,
		agentName,
		agentValidUntilMs,
		importedAtMs: nowMs,
		syncId: envelope.syncId,
		...(plaintext.preview === true ? { preview: true } : {}),
	};
}

export function encodeMobileSyncEnvelope(envelope: MobileSyncEnvelope): string {
	return bytesToBase64Url(utf8Encode(canonicalJson(validateMobileSyncEnvelope(envelope))));
}

export function decodeMobileSyncEnvelope(encoded: string): MobileSyncEnvelope {
	let parsed: unknown;
	try {
		parsed = JSON.parse(utf8Decode(base64UrlToBytes(encoded)));
	} catch {
		throw new MobileSyncError("invalid_payload_encoding");
	}
	return validateMobileSyncEnvelope(parsed);
}

export function isMobileSyncError(error: unknown): error is MobileSyncError {
	return error instanceof MobileSyncError;
}

function buildMobileSyncUrl(appOrigin: string, routePath: string, envelope: MobileSyncEnvelope): string {
	const url = new URL(routePath, appOrigin);
	url.hash = `${MOBILE_SYNC_FRAGMENT_KEY}=${encodeMobileSyncEnvelope(envelope)}`;
	return url.toString();
}

function createEnvelopeWithoutCiphertext(
	createdAtMs: number,
	expiresAtMs: number,
	crypto: Crypto,
): Omit<MobileSyncEnvelope, "ciphertext"> {
	const syncIdBytes = new Uint8Array(SYNC_ID_BYTES);
	const saltBytes = new Uint8Array(SALT_BYTES);
	const ivBytes = new Uint8Array(AES_GCM_IV_BYTES);
	crypto.getRandomValues(syncIdBytes);
	crypto.getRandomValues(saltBytes);
	crypto.getRandomValues(ivBytes);

	return {
		v: 1,
		type: MOBILE_SYNC_ENVELOPE_TYPE,
		syncId: bytesToBase64Url(syncIdBytes),
		createdAtMs,
		expiresAtMs,
		kdf: {
			name: "PBKDF2",
			hash: "SHA-256",
			iterations: MOBILE_SYNC_KDF_ITERATIONS,
			salt: bytesToBase64Url(saltBytes),
		},
		cipher: {
			name: "AES-GCM",
			length: AES_GCM_KEY_LENGTH,
			iv: bytesToBase64Url(ivBytes),
			tagLength: AES_GCM_TAG_LENGTH,
		},
	};
}

function assertValidAgentApproval(agentName: string, agentValidUntilMs: number, nowMs: number): void {
	if (
		!Number.isSafeInteger(agentValidUntilMs) ||
		agentValidUntilMs <= nowMs ||
		agentName !== createMobileAgentName(agentValidUntilMs)
	) {
		throw new MobileSyncError("invalid_plaintext");
	}
}

async function deriveMobileSyncKey(
	pairingCode: string,
	envelope: Omit<MobileSyncEnvelope, "ciphertext">,
	crypto: Crypto,
): Promise<CryptoKey> {
	const normalizedCode = normalizePairingCode(pairingCode);
	const keyMaterial = await crypto.subtle.importKey(
		"raw",
		toArrayBuffer(utf8Encode(`HypeTerminal mobile sync v1:${normalizedCode}`)),
		"PBKDF2",
		false,
		["deriveKey"],
	);
	return crypto.subtle.deriveKey(
		{
			name: "PBKDF2",
			hash: "SHA-256",
			salt: toArrayBuffer(base64UrlToBytes(envelope.kdf.salt)),
			iterations: envelope.kdf.iterations,
		},
		keyMaterial,
		{ name: "AES-GCM", length: AES_GCM_KEY_LENGTH },
		false,
		["encrypt", "decrypt"],
	);
}

function validateMobileSyncEnvelope(envelopeInput: unknown): MobileSyncEnvelope {
	const envelope = asRecord(envelopeInput, "invalid_envelope");
	if (envelope.v !== 1 || envelope.type !== MOBILE_SYNC_ENVELOPE_TYPE) {
		throw new MobileSyncError("invalid_envelope");
	}

	const createdAtMs = asSafeInteger(envelope.createdAtMs, "invalid_envelope");
	const expiresAtMs = asSafeInteger(envelope.expiresAtMs, "invalid_envelope");
	if (expiresAtMs <= createdAtMs || expiresAtMs - createdAtMs > MOBILE_SYNC_PAYLOAD_TTL_MS || createdAtMs <= 0) {
		throw new MobileSyncError("invalid_envelope");
	}

	const syncId = asString(envelope.syncId, "invalid_envelope");
	if (base64UrlToBytes(syncId).length !== SYNC_ID_BYTES) {
		throw new MobileSyncError("invalid_envelope");
	}

	const kdf = asRecord(envelope.kdf, "invalid_envelope");
	if (kdf.name !== "PBKDF2" || kdf.hash !== "SHA-256" || kdf.iterations !== MOBILE_SYNC_KDF_ITERATIONS) {
		throw new MobileSyncError("invalid_envelope");
	}
	const salt = asString(kdf.salt, "invalid_envelope");
	if (base64UrlToBytes(salt).length !== SALT_BYTES) {
		throw new MobileSyncError("invalid_envelope");
	}

	const cipher = asRecord(envelope.cipher, "invalid_envelope");
	if (cipher.name !== "AES-GCM" || cipher.length !== AES_GCM_KEY_LENGTH || cipher.tagLength !== AES_GCM_TAG_LENGTH) {
		throw new MobileSyncError("invalid_envelope");
	}
	const iv = asString(cipher.iv, "invalid_envelope");
	if (base64UrlToBytes(iv).length !== AES_GCM_IV_BYTES) {
		throw new MobileSyncError("invalid_envelope");
	}

	const ciphertext = asString(envelope.ciphertext, "invalid_envelope");
	if (base64UrlToBytes(ciphertext).length <= AES_GCM_TAG_LENGTH / 8) {
		throw new MobileSyncError("invalid_envelope");
	}

	return {
		v: 1,
		type: MOBILE_SYNC_ENVELOPE_TYPE,
		syncId,
		createdAtMs,
		expiresAtMs,
		kdf: {
			name: "PBKDF2",
			hash: "SHA-256",
			iterations: MOBILE_SYNC_KDF_ITERATIONS,
			salt,
		},
		cipher: {
			name: "AES-GCM",
			length: AES_GCM_KEY_LENGTH,
			iv,
			tagLength: AES_GCM_TAG_LENGTH,
		},
		ciphertext,
	};
}

function assertEnvelopeNotExpired(envelope: MobileSyncEnvelope, nowMs: number): void {
	if (nowMs > envelope.expiresAtMs + MOBILE_SYNC_CLOCK_SKEW_MS) {
		throw new MobileSyncError("expired_payload");
	}
}

function removeCiphertext(envelope: MobileSyncEnvelope): Omit<MobileSyncEnvelope, "ciphertext"> {
	return {
		v: envelope.v,
		type: envelope.type,
		syncId: envelope.syncId,
		createdAtMs: envelope.createdAtMs,
		expiresAtMs: envelope.expiresAtMs,
		kdf: envelope.kdf,
		cipher: envelope.cipher,
	};
}

function createEnvelopeAdditionalData(envelope: Omit<MobileSyncEnvelope, "ciphertext">): Uint8Array {
	return utf8Encode(`HypeTerminal mobile sync envelope v1:${canonicalJson(envelope)}`);
}

function validateOrigin(issuerOrigin: string, currentOrigin: string | undefined, allowedOrigins: string[] | undefined) {
	const normalizedIssuer = normalizeOrigin(issuerOrigin);
	const allowed = new Set((allowedOrigins ?? []).map(normalizeOrigin));
	if (currentOrigin) allowed.add(normalizeOrigin(currentOrigin));
	if (allowed.size > 0 && !allowed.has(normalizedIssuer)) {
		throw new MobileSyncError("origin_mismatch");
	}
}

function normalizeOrigin(origin: string): string {
	try {
		const url = new URL(origin);
		return url.origin;
	} catch {
		throw new MobileSyncError("invalid_plaintext");
	}
}

function normalizeAddress(value: unknown, errorCode: MobileSyncErrorCode): Address {
	if (typeof value !== "string" || !isAddress(value)) {
		throw new MobileSyncError(errorCode);
	}
	return getAddress(value).toLowerCase() as Address;
}

function normalizePrivateKey(value: unknown): Hex {
	if (typeof value !== "string" || !HEX_PRIVATE_KEY_RE.test(value)) {
		throw new MobileSyncError("invalid_plaintext");
	}
	return value.toLowerCase() as Hex;
}

function asRecord(value: unknown, errorCode: MobileSyncErrorCode): JsonRecord {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		throw new MobileSyncError(errorCode);
	}
	return value as JsonRecord;
}

function asString(value: unknown, errorCode: MobileSyncErrorCode): string {
	if (typeof value !== "string" || value.length === 0) {
		throw new MobileSyncError(errorCode);
	}
	return value;
}

function asSafeInteger(value: unknown, errorCode: MobileSyncErrorCode): number {
	if (typeof value !== "number" || !Number.isSafeInteger(value)) {
		throw new MobileSyncError(errorCode);
	}
	return value;
}

function canonicalJson(value: unknown): string {
	return JSON.stringify(sortJsonValue(value));
}

function sortJsonValue(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(sortJsonValue);
	if (!value || typeof value !== "object") return value;
	const sorted: JsonRecord = {};
	for (const key of Object.keys(value).sort()) {
		sorted[key] = sortJsonValue((value as JsonRecord)[key]);
	}
	return sorted;
}

function bytesToBase64Url(bytes: Uint8Array): string {
	let binary = "";
	for (const byte of bytes) {
		binary += String.fromCharCode(byte);
	}
	return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/u, "");
}

function base64UrlToBytes(input: string): Uint8Array {
	if (!/^[A-Za-z0-9_-]+$/.test(input)) {
		throw new MobileSyncError("invalid_payload_encoding");
	}
	const padded = input
		.replace(/-/g, "+")
		.replace(/_/g, "/")
		.padEnd(Math.ceil(input.length / 4) * 4, "=");
	let binary: string;
	try {
		binary = atob(padded);
	} catch {
		throw new MobileSyncError("invalid_payload_encoding");
	}
	const bytes = new Uint8Array(binary.length);
	for (let i = 0; i < binary.length; i++) {
		bytes[i] = binary.charCodeAt(i);
	}
	return bytes;
}

function utf8Encode(input: string): Uint8Array {
	return new TextEncoder().encode(input);
}

function utf8Decode(input: Uint8Array): string {
	return new TextDecoder().decode(input);
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
	const copy = new Uint8Array(bytes.byteLength);
	copy.set(bytes);
	return copy.buffer;
}

function getCrypto(): Crypto {
	const crypto = globalThis.crypto;
	if (!crypto?.subtle) {
		throw new MobileSyncError("invalid_envelope");
	}
	return crypto;
}

function getMobileSyncErrorMessage(code: MobileSyncErrorCode): string {
	if (code === "expired_payload") return "This mobile trading link has expired.";
	if (code === "invalid_pairing_code") return "Invalid pairing code.";
	return "Invalid mobile sync payload.";
}

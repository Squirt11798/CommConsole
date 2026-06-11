/**
 * TOFU (Trust On First Use) host key store.
 * Fingerprints are stored as SHA-256 hex strings keyed by "host:port".
 * On first connect the user is prompted to verify the fingerprint.
 * On subsequent connects a mismatch aborts the connection with a warning.
 */

import { app } from 'electron'
import { join } from 'path'
import { readFileSync, writeFileSync, existsSync } from 'fs'
import { createHash } from 'crypto'

type KnownHosts = Record<string, string>  // "host:port" -> SHA-256 hex fingerprint

const hostsPath = (): string => join(app.getPath('userData'), 'known_hosts.json')

function load(): KnownHosts {
  try {
    if (!existsSync(hostsPath())) return {}
    return JSON.parse(readFileSync(hostsPath(), 'utf-8'))
  } catch { return {} }
}

function store(hosts: KnownHosts): void {
  writeFileSync(hostsPath(), JSON.stringify(hosts, null, 2), 'utf-8')
}

export function computeFingerprint(key: Buffer): string {
  return createHash('sha256').update(key).digest('hex')
}

export type HostCheckResult =
  | { status: 'ok' }
  | { status: 'new'; fingerprint: string }
  | { status: 'changed'; fingerprint: string; stored: string }

export function checkHost(host: string, port: number, fp: string): HostCheckResult {
  const entry = `${host}:${port}`
  const hosts = load()
  if (!(entry in hosts)) return { status: 'new', fingerprint: fp }
  if (hosts[entry] === fp) return { status: 'ok' }
  return { status: 'changed', fingerprint: fp, stored: hosts[entry] }
}

export function trustHost(host: string, port: number, fp: string): void {
  const entry = `${host}:${port}`
  const hosts = load()
  hosts[entry] = fp
  store(hosts)
}

export function forgetHost(host: string, port: number): void {
  const entry = `${host}:${port}`
  const hosts = load()
  delete hosts[entry]
  store(hosts)
}

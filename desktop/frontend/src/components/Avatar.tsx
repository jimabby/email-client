import { useEffect, useState } from 'react'

// Contact avatars.
//
// Gravatar needs an MD5 of the address, and the browser's SubtleCrypto has no
// MD5. Rather than pull in a hashing dependency for this, Hermes asks Gravatar
// for the *SHA-256* form it also accepts (supported since 2024), and falls back
// to coloured initials whenever the address has no avatar or the request fails.

const PALETTE = ['#1d4ed8', '#7c3aed', '#059669', '#d97706', '#db2777', '#0891b2', '#dc2626', '#4338ca']

export function bareAddress(from: string): string {
  return (from.match(/<([^>]+)>/)?.[1] || from).trim().toLowerCase()
}

export function getInitials(from: string): string {
  const name = from.replace(/<.*>/, '').trim()
  if (!name) return '?'
  const parts = name.split(/\s+/).filter(Boolean)
  if (parts.length >= 2) return (parts[0][0] + parts[1][0]).toUpperCase()
  return name.slice(0, 2).toUpperCase()
}

export function getAvatarColor(from: string): string {
  let hash = 0
  for (const c of from) hash = (hash * 31 + c.charCodeAt(0)) & 0xffff
  return PALETTE[hash % PALETTE.length]
}

// Cache hashes across renders — the same senders recur constantly in a list.
const hashCache = new Map<string, string>()

async function sha256Hex(value: string): Promise<string | null> {
  const cached = hashCache.get(value)
  if (cached) return cached
  if (typeof crypto === 'undefined' || !crypto.subtle) return null
  try {
    const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))
    const hex = Array.from(new Uint8Array(bytes)).map(b => b.toString(16).padStart(2, '0')).join('')
    hashCache.set(value, hex)
    return hex
  } catch {
    return null
  }
}

export function Avatar({ from, size = 32, className = '' }: { from: string; size?: number; className?: string }) {
  const [src, setSrc] = useState<string | null>(null)
  const [failed, setFailed] = useState(false)
  const address = bareAddress(from)

  useEffect(() => {
    let cancelled = false
    setSrc(null)
    setFailed(false)
    if (!address.includes('@')) return
    sha256Hex(address).then(hash => {
      // d=404 makes Gravatar 404 rather than serve a placeholder, so the
      // initials fallback shows for addresses with no avatar.
      if (!cancelled && hash) setSrc(`https://www.gravatar.com/avatar/${hash}?s=${size * 2}&d=404`)
    })
    return () => { cancelled = true }
  }, [address, size])

  const initials = getInitials(from)
  const showImage = src && !failed

  return (
    <div
      className={`rounded-full flex items-center justify-center font-bold text-white flex-shrink-0 overflow-hidden ${className}`}
      style={{
        width: size,
        height: size,
        fontSize: Math.max(9, Math.round(size * 0.34)),
        backgroundColor: getAvatarColor(from),
      }}
      title={address || from}
    >
      {showImage ? (
        <img
          src={src}
          alt=""
          width={size}
          height={size}
          className="w-full h-full object-cover"
          referrerPolicy="no-referrer"
          onError={() => setFailed(true)}
        />
      ) : (
        initials
      )}
    </div>
  )
}

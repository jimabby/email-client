/**
 * Rasterise the unread count for the Windows taskbar overlay.
 *
 * `BrowserWindow.setOverlayIcon` wants an image, and there is nothing in the
 * Electron main process that can turn the number 12 into a bitmap — no canvas,
 * no text shaping. The renderer has both, so the shell asks for a badge over
 * IPC and gets a PNG data URL back.
 *
 * Windows draws the overlay at 16x16 in the taskbar; rendering at 32 and
 * letting the compositor downscale keeps the digits from turning to mush.
 */

const SIZE = 32

export function drawUnreadBadge(count: number): string | null {
  if (!Number.isFinite(count) || count <= 0) return null

  let canvas: HTMLCanvasElement
  try {
    canvas = document.createElement('canvas')
  } catch {
    return null
  }
  canvas.width = SIZE
  canvas.height = SIZE

  const ctx = canvas.getContext('2d')
  if (!ctx) return null

  // A filled disc rather than a rounded rect: the taskbar clips the overlay to
  // a small square, and a circle survives that at any DPI.
  ctx.beginPath()
  ctx.arc(SIZE / 2, SIZE / 2, SIZE / 2 - 1, 0, Math.PI * 2)
  ctx.fillStyle = '#e5484d'
  ctx.fill()

  // A rim, so the badge stays legible against a light taskbar.
  ctx.lineWidth = 1.5
  ctx.strokeStyle = 'rgba(0, 0, 0, 0.28)'
  ctx.stroke()

  // Past 99 the digits stop being readable at 16px, so it becomes a marker.
  const label = count > 99 ? '99+' : String(count)
  ctx.fillStyle = '#ffffff'
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  ctx.font = `600 ${label.length >= 3 ? 13 : label.length === 2 ? 17 : 20}px "Segoe UI", system-ui, sans-serif`
  // +1 nudges off the optical centre onto the geometric one.
  ctx.fillText(label, SIZE / 2, SIZE / 2 + 1)

  try {
    return canvas.toDataURL('image/png')
  } catch {
    return null
  }
}

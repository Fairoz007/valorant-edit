import { describe, expect, test } from 'vitest'
import { mediaUrl, pathFromMediaUrl } from './media-url'

describe('mediaUrl', () => {
  test.each([
    ['C:\\v\\a.mp4', 'aditor-media://local/C:/v/a.mp4'],
    ['c:\\v\\a.mp4', 'aditor-media://local/c:/v/a.mp4'],
    ['D:/clips/a.mp4', 'aditor-media://local/D:/clips/a.mp4'],
    ['D:\\テスト clips\\a #1?.mp4', 'aditor-media://local/D:/%E3%83%86%E3%82%B9%E3%83%88%20clips/a%20%231%3F.mp4'],
    ['\\\\server\\share\\a 100%.mp4', 'aditor-media://unc/server/share/a%20100%25.mp4'],
    ['/Users/x/a.mp4', 'aditor-media://local/Users/x/a.mp4'],
    ['C:\\Users\\Zoë Ünal\\Videos\\a&b+c=d;e,f@g$h!i\'j(k)l[m]n~.mp4',
      'aditor-media://local/C:/Users/Zo%C3%AB%20%C3%9Cnal/Videos/a%26b%2Bc%3Dd%3Be%2Cf%40g%24h!i\'j(k)l%5Bm%5Dn~.mp4']
  ])('%s → %s', (input, url) => {
    expect(mediaUrl(input)).toBe(url)
  })

  test('the URL survives Chromium-style parsing unchanged (no host confusion, no lost #/?)', () => {
    const u = new URL(mediaUrl('D:\\テスト clips\\a #1?.mp4'))
    expect(u.hostname).toBe('local')
    expect(u.hash).toBe('')
    expect(u.search).toBe('')
  })
})

describe('pathFromMediaUrl (round trip)', () => {
  test.each([
    ['C:\\v\\a.mp4'],
    ['c:\\v\\a.mp4'],
    ['D:\\テスト clips\\a #1?.mp4'],
    ['D:\\テスト clips #1 100%\\a #1.mp4'],
    ['\\\\server\\share\\a 100%.mp4'],
    ['C:\\Users\\Zoë Ünal\\Videos\\a&b+c=d;e,f@g$h!i\'j(k)l[m]n~.mp4']
  ])('win32: %s', (p) => {
    expect(pathFromMediaUrl(mediaUrl(p), 'win32')).toBe(p)
  })
  test('win32: forward slashes come back as backslashes', () => {
    expect(pathFromMediaUrl(mediaUrl('D:/clips/a.mp4'), 'win32')).toBe('D:\\clips\\a.mp4')
  })
  test('posix: /Users/x/a b#?.mp4', () => {
    expect(pathFromMediaUrl(mediaUrl('/Users/x/a b#?.mp4'), 'darwin')).toBe('/Users/x/a b#?.mp4')
  })
})

describe('pathFromMediaUrl rejects', () => {
  test.each([
    ['foreign scheme', 'file:///C:/v/a.mp4'],
    ['foreign host', 'aditor-media://evil/C:/v/a.mp4'],
    ['credentials', 'aditor-media://u:p@local/C:/v/a.mp4'],
    ['encoded backslash inside a segment', 'aditor-media://local/C:/v%5C..%5Csecret.mp4'],
    ['encoded slash inside a segment', 'aditor-media://local/C:/v%2F..%2Fsecret.mp4'],
    ['encoded NUL', 'aditor-media://local/C:/v/a%00.mp4'],
    ['malformed percent escape', 'aditor-media://local/C:/v/a%E0%A4%A.mp4'],
    ['no drive letter on Windows', 'aditor-media://local/Users/x/a.mp4'],
    ['drive only', 'aditor-media://local/C:'],
    ['empty path', 'aditor-media://local/'],
    ['UNC without a file', 'aditor-media://unc/server/share'],
    ['UNC device path \\\\?\\', 'aditor-media://unc/%3F/C:/a.mp4'],
    ['UNC device path \\\\.\\', 'aditor-media://unc/./C:/a.mp4'],
    ['garbage', 'not a url']
  ])('%s', (_name, url) => {
    expect(pathFromMediaUrl(url, 'win32')).toBeNull()
  })

  test('dot segments are resolved by the URL parser before we see them, so they cannot escape a checked path', () => {
    // `..` (and its %2E%2E spelling) is collapsed exactly as Chromium does for a standard scheme; the result is then allowlist-checked.
    expect(pathFromMediaUrl('aditor-media://local/C:/lib/../secret.mp4', 'win32')).toBe('C:\\secret.mp4')
    expect(pathFromMediaUrl('aditor-media://local/C:/lib/%2E%2E/secret.mp4', 'win32')).toBe('C:\\secret.mp4')
  })
})

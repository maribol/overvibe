// A web address printed without https:// ("docs.elasticfunnels.io/analytics/x") is a link to that site,
// not a file in the session's folder [T1112-133]. Only common site endings count, none that is also a
// file type (.md, .ts, .sh, .ai, .app...), so notes.md/x and Overvibe.app stay paths.
const TLD = 'com|io|dev|org|net|co|me|so|xyz|gg|tv|fm|us|uk|de|fr|es|it|nl|eu|ca|au|ch|se|no|jp|ro|cloud|site|online|tech|store|blog|page|link|news|info|biz|pro|ly|to'
const HOST = new RegExp(`^(?:www\\.)?(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\\.)+(?:${TLD})$`, 'i')

/** "https://<text>" when the text starts with a site's name, else null */
export function hostUrl(text: string): string | null {
  const host = text.split('/')[0]!
  return HOST.test(host) ? `https://${text}` : null
}

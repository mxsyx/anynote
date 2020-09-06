import crypto from 'crypto'

type DateFormat = 'datetime' | 'timestamp'
export function getNow(format: DateFormat): string {
  const now = new Date()

  switch (format) {
    case 'datetime': {
      return now.toLocaleString()
    }
    default: {
      return String(now.getTime())
    }
  }
}

/**
 * Encrypt data by using aes-128-ecb.
 * @param key The secret key.
 * @param data Data to be encrypted.
 */
export function encrypt(key: string, data: string): string {
  const cipher = crypto.createCipheriv('aes-128-ecb', key, null)
  return cipher.update(data, 'utf8', 'base64') + cipher.final('base64')
}

/**
 * Decrypt data by using aes-128-ecb.
 * @param key The secret key.
 * @param data Data to be decrypted.
 */
export function decrypt(key: string, data: string): string {
  const cipher = crypto.createDecipheriv('aes-128-ecb', key, null)
  return cipher.update(data, 'base64', 'utf8') + cipher.final('utf8')
}

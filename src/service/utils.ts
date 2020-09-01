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

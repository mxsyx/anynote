/*
 * File: /src/service/logger.ts
 * Author: Mxsyx (mxsyxin@gmail.com)
 * Created At: 2020-11-21 01:05:52
 * -----
 * Last Modified: 2020-11-21 01:22:52
 * Modified By: Mxsyx (mxsyxin@gmail.com>)
 * -----
 * Lisense: GNU General Public License v3
 */

import fs = require('fs')
import { Logger } from 'typeorm'

// 
function formatSqlQuery(query: string, parameters?: string[]) {
  switch (query) {
    case  'BEGIN TRANSACTION': return `\n${query}`
    case  'COMMIT': return `${query}\n`
    default: {
      if (parameters) {
        for (let i = 0; i < parameters.length; i++) {
          query = query.replace('?', parameters[i] || 'null')
        }
      }
      return query
    }
  }
}

export class OrmLogger implements Logger {
  private logFilePath: string

  constructor() {
    this.logFilePath = './ormlog.sql'
  }

  writeLog(content: string): void {
    // eslint-disable-next-line @typescript-eslint/no-empty-function
    fs.appendFile(this.logFilePath, `${content}\n`, () => { })
  }

  logQuery(query: string, parameters?: string[]): void {
    this.writeLog(formatSqlQuery(query, parameters))
  }

  log(level: "log" | "info" | "warn", message: unknown): void {
    this.writeLog(`[${level}]: ${message}`)
  }
  logQueryError(error: string, query: string): void {
    this.writeLog(`[${error}]: ${query}`)
  }
  logQuerySlow(time: number, query: string): void {
    this.writeLog(`[slow][${time}]: ${query}`)
  }
  logSchemaBuild(message: string): void {
    this.writeLog(message)
  }
  logMigration(message: string): void {
    this.writeLog(message)
  }
}

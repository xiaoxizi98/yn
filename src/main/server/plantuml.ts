import * as crypto from 'crypto'
import fs from 'fs-extra'
import path from 'path'
import pako from 'pako'
import { PlantUmlPipe } from 'plantuml-pipe'
import commandExists from 'command-exists'
import config from '../config'
import { ASSETS_DIR, BIN_DIR, CACHE_DIR } from '../constant'
import { getAction } from '../action'
import { request } from 'undici'
import { finished } from 'stream/promises';

function plantumlBase64 (base64: string) {
  // eslint-disable-next-line quote-props
  const map: any = { 'A': '0', 'B': '1', 'C': '2', 'D': '3', 'E': '4', 'F': '5', 'G': '6', 'H': '7', 'I': '8', 'J': '9', 'K': 'A', 'L': 'B', 'M': 'C', 'N': 'D', 'O': 'E', 'P': 'F', 'Q': 'G', 'R': 'H', 'S': 'I', 'T': 'J', 'U': 'K', 'V': 'L', 'W': 'M', 'X': 'N', 'Y': 'O', 'Z': 'P', 'a': 'Q', 'b': 'R', 'c': 'S', 'd': 'T', 'e': 'U', 'f': 'V', 'g': 'W', 'h': 'X', 'i': 'Y', 'j': 'Z', 'k': 'a', 'l': 'b', 'm': 'c', 'n': 'd', 'o': 'e', 'p': 'f', 'q': 'g', 'r': 'h', 's': 'i', 't': 'j', 'u': 'k', 'v': 'l', 'w': 'm', 'x': 'n', 'y': 'o', 'z': 'p', '0': 'q', '1': 'r', '2': 's', '3': 't', '4': 'u', '5': 'v', '6': 'w', '7': 'x', '8': 'y', '9': 'z', '+': '-', '/': '_', '=': '' }
  return base64.split('').map(x => map[x] || '').join('')
}

function getCacheKey (api: string, type: string, data: string) {
  return crypto.createHash('sha256').update(api + type + data).digest('hex')
}

async function gcCache (cacheDir: string) {
  const files = await fs.readdir(cacheDir)
  if (files.length < 4000) {
    return
  }

  const stats = await Promise.all(files.map(file => fs.stat(path.join(cacheDir, file))))
  stats.sort((a, b) => a.atimeMs - b.atimeMs)

  for (let i = 0; i < stats.length / 2; i++) {
    await fs.remove(path.join(cacheDir, files[i]))
  }
}


async function getCacheData (key: string, gen: () => Promise<any>) {
  const cacheDir = path.join(CACHE_DIR, 'plantuml')

  await fs.ensureDir(cacheDir)

  gcCache(cacheDir)

  const cacheFile = path.join(cacheDir, key)
  console.log("get data",cacheFile);

  if (await fs.pathExists(cacheFile)) {
    const stat = await fs.stat(cacheFile)
    if (stat.size) {
      return fs.createReadStream(cacheFile)
    }
  }
  
  const data = await gen()
  if (!data) {
    throw new Error('No data')
  }

  let lastError: Error | null = null;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      if (typeof data.pipe === 'function') {
        // 如果是流数据，需要重新创建可读流（因为流只能消费一次）
        const dataStream = await gen(); // 重新获取数据流
        const writeStream = fs.createWriteStream(cacheFile);
        dataStream.pipe(writeStream);
        await finished(writeStream);
      } else {
        // 非流数据直接写入
        await fs.writeFile(cacheFile, data);
      }

      // 验证写入结果
      const stat = await fs.stat(cacheFile);
      if (stat.size === 0) {
        throw new Error('Empty file after write');
      }

      return data;
    } catch (error) {
      lastError = error as Error;
      // 清理可能不完整的文件
      if (await fs.pathExists(cacheFile)) {
        await fs.remove(cacheFile).catch(() => {});
      }
      if (attempt < 3) {
        console.log("重试第"+attempt+"次");
        
        await new Promise(resolve => setTimeout(resolve, 200 * attempt)); // 延迟重试
      }
    }
  }
  throw new Error(`Failed to write cache after 3 attempts: ${lastError?.message}`);
}

export default async function (data: string): Promise<{ content: any, type: string }> {
  const api: string = config.get('plantuml-api', 'local')
  
  if (api.startsWith('local')) {
    try {
      await commandExists('java')
    } catch {
      throw fs.createReadStream(path.join(ASSETS_DIR, 'no-java-runtime.png'))
    }

    const format = api.split('-')[1] || 'png'
    const type = format === 'png' ? 'image/png' : 'image/svg+xml'

    const cacheKey = getCacheKey(api, type, data)
    const content = await getCacheData(cacheKey, async () => {
      const jarPath = path.join(BIN_DIR, 'plantuml.jar')

      const puml = new PlantUmlPipe({
        split: format === 'svg',
        outputFormat: format as 'png' | 'svg',
        plantUmlArgs: ['-charset', 'UTF-8'],
        jarPath,
      })

      puml.in.write(pako.inflateRaw(Buffer.from(data, 'base64')))
      puml.in.end()

      return puml.out
    })

    return { content, type }
  } else {
    const url = api.replace('{data}', plantumlBase64(data))
    const dispatcher = await getAction('get-proxy-dispatcher')(url)
    let type = api.includes('/svg/') ? 'image/svg+xml' : 'image/png'

    const cacheKey = getCacheKey(api, type, data)
    const content = await getCacheData(cacheKey, async () => {
      const res = await request(url, { dispatcher })
      type = res.headers['content-type'] as string
      return res.body
    })

    return { content, type }
  }
}

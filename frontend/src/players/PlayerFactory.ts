import type { IPlayerAdapter } from './IPlayerAdapter'
import { RutubeAdapter } from './RutubeAdapter'
import { VKVideoAdapter } from './VKVideoAdapter'

export type Platform = 'rutube' | 'vkvideo' | 'youtube' | 'vimeo'

function detectPlatform(url: string): Platform | null {
  if (url.includes('rutube.ru')) return 'rutube'
  if (url.includes('vk.com/video') || url.includes('vkvideo.ru')) return 'vkvideo'
  if (url.includes('youtube.com') || url.includes('youtu.be')) return 'youtube'
  if (url.includes('vimeo.com')) return 'vimeo'
  return null
}

export class PlayerFactory {
  static create(url: string, container: HTMLElement): IPlayerAdapter {
    const platform = detectPlatform(url)
    switch (platform) {
      case 'rutube':
        return new RutubeAdapter(url, container)
      case 'vkvideo':
        return new VKVideoAdapter(url, container)
      case null:
        throw new Error(`Неизвестная платформа: ${url}`)
      default:
        throw new Error(`Адаптер для "${platform}" ещё не реализован`)
    }
  }

  static detect(url: string): Platform | null {
    return detectPlatform(url)
  }
}

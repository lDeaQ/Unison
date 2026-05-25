import type { IPlayerAdapter } from './IPlayerAdapter'

export type Platform = 'rutube' | 'vkvideo' | 'youtube' | 'vimeo'

function detectPlatform(url: string): Platform | null {
  if (url.includes('rutube.ru')) return 'rutube'
  if (url.includes('vk.com/video') || url.includes('vkvideo.ru')) return 'vkvideo'
  if (url.includes('youtube.com') || url.includes('youtu.be')) return 'youtube'
  if (url.includes('vimeo.com')) return 'vimeo'
  return null
}

export class PlayerFactory {
  static create(_url: string, _container: HTMLElement): IPlayerAdapter {
    const platform = detectPlatform(_url)
    if (!platform) {
      throw new Error(`Неизвестная платформа: ${_url}`)
    }
    // Адаптеры будут подключены по мере реализации
    throw new Error(`Адаптер для "${platform}" ещё не реализован`)
  }
}

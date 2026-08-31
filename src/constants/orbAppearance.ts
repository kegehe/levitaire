export const ORB_ICON_OPTIONS = [
  { id: "jellyfish", label: "水母", description: "触须缓摆" },
  { id: "ufo", label: "UFO 飞碟", description: "光束闪烁" },
  { id: "butterfly", label: "蝴蝶", description: "翅膀扇动" },
  { id: "balloon", label: "热气球", description: "轻盈漂浮" },
  { id: "rocket", label: "火箭", description: "余烬微颤" },
  { id: "cloud", label: "云朵", description: "静默漂浮" },
  { id: "plane", label: "纸飞机", description: "平稳滑翔" },
  { id: "dandelion", label: "蒲公英", description: "冠毛轻晃" },
  { id: "kite", label: "风筝", description: "尾线轻摆" },
  { id: "bubble", label: "气泡", description: "柔软呼吸" },
] as const;

export type OrbIconId = (typeof ORB_ICON_OPTIONS)[number]["id"];

const STORAGE_KEY = "levitaire-orb-icon";

const ICON_MARKUP: Record<OrbIconId, string> = {
  jellyfish:
    '<g class="an-jelly"><path class="an-dome" d="M4.8 12.2a7.2 7.2 0 0 1 14.4 0c0 .5-.4.9-.9.9H5.7c-.5 0-.9-.4-.9-.9z"/><path class="an-t1" d="M7.6 14.2v2.3c0 1.1-.6 1.7-.6 2.6"/><path class="an-t2" d="M10.4 14.2v3.4c0 1.2.7 1.8.7 2.8"/><path class="an-t3" d="M13.6 14.2v3.4c0 1.2-.7 1.8-.7 2.8"/><path class="an-t4" d="M16.4 14.2v2.3c0 1.1.6 1.7.6 2.6"/></g>',
  ufo: '<path class="an-beam" d="M7.6 13.6 5.6 19.4h12.8l-2-5.8z" fill="currentColor" stroke="none" opacity=".14"/><g class="an-ufo"><path d="M9.2 10.7a2.8 2.8 0 0 1 5.6 0z" fill="currentColor" fill-opacity=".16"/><ellipse cx="12" cy="11.7" rx="7.8" ry="2.4"/><circle class="an-lt1" cx="8.2" cy="12.1" r=".72" fill="currentColor" stroke="none"/><circle class="an-lt2" cx="12" cy="12.7" r=".72" fill="currentColor" stroke="none"/><circle class="an-lt3" cx="15.8" cy="12.1" r=".72" fill="currentColor" stroke="none"/></g>',
  butterfly:
    '<path d="M11.7 6.9c-.5-1.2-1.2-1.8-2-2.1M12.3 6.9c.5-1.2 1.2-1.8 2-2.1M12 6.8v10.4"/><path class="an-bl1" d="M11.5 9.4C9 6.8 5.6 6.4 4.4 8c-1 1.4.4 3.6 2.8 4.2 1.6.4 3 0 4.3-1z"/><path class="an-br1" d="M12.5 9.4C15 6.8 18.4 6.4 19.6 8c1 1.4-.4 3.6-2.8 4.2-1.6.4-3 0-4.3-1z"/><path class="an-bl2" d="M11.5 13.6c-1.7 1.3-3.8 2.5-5 1.7-.9-.6-.6-2.3.9-3.3 1-.7 2.5-.8 4.1-.2z"/><path class="an-br2" d="M12.5 13.6c1.7 1.3 3.8 2.5 5 1.7.9-.6.6-2.3-.9-3.3-1-.7-2.5-.8-4.1-.2z"/>',
  balloon:
    '<g class="an-balloon"><path d="M12 3.4c3.6 0 6.5 2.9 6.5 6.4 0 2.6-1.4 4.3-3 5.6-.9.7-1.4 1.3-1.6 2.1h-3.8c-.2-.8-.7-1.4-1.6-2.1-1.6-1.3-3-3-3-5.6 0-3.5 2.9-6.4 6.5-6.4z"/><path d="M8.4 5.4c-.7 1.5-.7 3.1 0 4.6M15.6 5.4c.7 1.5.7 3.1 0 4.6M9.6 17.5h4.8l-.6 1.5h-3.6z"/><rect x="9.4" y="19" width="5.2" height="2.4" rx=".9"/></g>',
  rocket:
    '<g class="an-rocket"><path class="an-fire" d="M10.2 16.4c.6 1.7 1.1 2.8 1.8 3.9.7-1.1 1.2-2.2 1.8-3.9z" fill="currentColor" stroke="none" opacity=".85"/><path d="M12 2.8c2.6 2.4 4 5.6 4 9.2 0 1.6-.3 3-.9 4.2H8.9c-.6-1.2-.9-2.6-.9-4.2 0-3.6 1.4-6.8 4-9.2z"/><circle cx="12" cy="9.8" r="1.7"/><path d="M7.6 11.4 5 15.4l2.6-.6zM16.4 11.4 19 15.4l-2.6-.6z" fill="currentColor" stroke="none"/></g>',
  cloud:
    '<g class="an-cloud"><path d="M6.4 15.4a3.5 3.5 0 0 1 .4-7 5.1 5.1 0 0 1 9.7-1.2 3.8 3.8 0 0 1 1.5 8.2z"/><path class="an-r1 an-hide" d="M8.6 17.6v1.9"/><path class="an-r2 an-hide" d="M12 17.9v2.1"/><path class="an-r3 an-hide" d="M15.4 17.6v1.9"/></g>',
  plane:
    '<path class="an-tr1 an-hide" d="m2.8 14.6 2.8 1.2"/><path class="an-tr2 an-hide" d="m2.2 17.4 2.4 1"/><g class="an-plane"><path d="m20.6 3.4-17.2 7.2 6 2.4 2.2 6.8z"/><path d="m20.6 3.4-11.2 10.2"/></g>',
  dandelion:
    '<path d="M12 21.2v-6.6"/><g class="an-puff"><path d="M12 14.2V8.4M12 14.2 8.2 10.6M12 14.2l3.8-3.6M12 14.2l-5.2-1.1M12 14.2l5.2-1.1M12 14.2l-1.9-5.6M12 14.2l1.9-5.6"/><circle class="an-s1" cx="12" cy="7.8" r=".68" fill="currentColor" stroke="none"/><circle class="an-s2" cx="7.6" cy="10" r=".68" fill="currentColor" stroke="none"/><circle class="an-s3" cx="16.4" cy="10" r=".68" fill="currentColor" stroke="none"/><circle class="an-s4" cx="10" cy="8" r=".68" fill="currentColor" stroke="none"/><circle class="an-s5" cx="14" cy="8" r=".68" fill="currentColor" stroke="none"/></g>',
  kite: '<g class="an-kite"><path d="m12 3.2 4.7 5.1-4.7 5.1-4.7-5.1zM12 3.2v10.2M7.3 8.3h9.4"/><path class="an-tl1" d="M12 13.4c1.3 1.2-1.3 2.2 0 3.4"/><path class="an-tl2" d="M12 16.8c1.3 1.1-1.3 1.9 0 3"/><path d="M10.6 16.1h2.8"/></g>',
  bubble:
    '<circle class="an-sb1 an-hide" cx="4.6" cy="17.8" r="1.4"/><circle class="an-sb2 an-hide" cx="19.4" cy="7.4" r="1.15"/><circle class="an-sb3 an-hide" cx="17.2" cy="18.6" r=".95"/><g class="an-bubf"><g class="an-bub"><circle cx="12" cy="11.4" r="7"/><path d="M8.5 8.7a3.3 3.3 0 0 1 2.5-1.4"/></g></g>',
};

export function getOrbIcon(): OrbIconId {
  const value = localStorage.getItem(STORAGE_KEY) as OrbIconId | null;
  return value && value in ICON_MARKUP ? value : "jellyfish";
}

export function setOrbIcon(icon: OrbIconId): void {
  localStorage.setItem(STORAGE_KEY, icon);
}

export function getOrbIconMarkup(icon: OrbIconId): string {
  return ICON_MARKUP[icon] ?? ICON_MARKUP.jellyfish;
}

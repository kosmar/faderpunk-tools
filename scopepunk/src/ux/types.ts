/** Cheatsheet-derived UX catalog (from faderpunk docs/apps manual.json). */

export type AppUxSection = {
  heading: string;
  items: string[];
};

export type AppUxChannel = {
  jackTitle?: string;
  jackDescription?: string;
  faderTitle?: string;
  faderDescription?: string;
  faderPlusShiftTitle?: string;
  faderPlusShiftDescription?: string;
  faderPlusFnTitle?: string;
  faderPlusFnDescription?: string;
  fnTitle?: string;
  fnDescription?: string;
  fnPlusShiftTitle?: string;
  fnPlusShiftDescription?: string;
  ledTop?: string;
  ledBottom?: string;
};

export type AppUx = {
  id: number;
  name: string;
  blurb: string;
  sections: AppUxSection[];
  channels: AppUxChannel[];
};

export type AppUxCatalog = {
  version: number;
  apps: Record<string, AppUx>;
};


import { create } from 'zustand';
import { persist } from 'zustand/middleware';

// Recent item type for folder navigation history
export interface RecentItem {
  key: string;
  name: string;
  bucket: string;
  region?: string;
  profileId?: string;
  isFolder: boolean;
  timestamp?: number;
}

export type FavoriteItem = RecentItem;

export interface RecentPathEntry {
  path: string;
  profileId?: string;
}

interface HistoryState {
  recentPaths: string[]; // Legacy field kept for persisted state compatibility
  recentPathEntries: RecentPathEntry[];
  recentItems: RecentItem[]; // For inner navigation history
  
  addPath: (path: string, profileId?: string) => void;
  addRecent: (item: RecentItem) => void; // New method for bucket/page.tsx
  clearRecent: (profileId?: string) => void;
  clearHistory: (profileId?: string) => void;
  
  // Stubs for Favorites (used in page.tsx too)
  favorites: RecentItem[];
  addFavorite: (item: RecentItem) => void;
  removeFavorite: (key: string, bucket?: string, profileId?: string) => void;
  isFavorite: (key: string, bucket?: string, profileId?: string) => boolean;
  clearFavorites: (profileId?: string) => void;
}

export const useHistoryStore = create<HistoryState>()(
  persist(
    (set, get) => ({
      recentPaths: [],
      recentPathEntries: [],
      recentItems: [],
      favorites: [],
      
      addPath: (path, profileId) => set((state) => {
        const nextEntry = { path, profileId };
        const filteredEntries = state.recentPathEntries.filter((entry) => !(
          entry.path === path &&
          entry.profileId === profileId
        ));
        return {
          recentPaths: [path, ...state.recentPaths.filter((existingPath) => existingPath !== path)].slice(0, 20),
          recentPathEntries: [nextEntry, ...filteredEntries].slice(0, 20),
        };
      }),
      
      addRecent: (item) => set((state) => {
        // Similar dedupe logic for items
        const newItem = { ...item, timestamp: Date.now() };
        const filtered = state.recentItems.filter(i => !(
          i.key === item.key &&
          i.bucket === item.bucket &&
          i.region === item.region &&
          i.profileId === item.profileId
        ));
        return { recentItems: [newItem, ...filtered].slice(0, 50) };
      }),
      
      addFavorite: (item) => set((state) => {
        // Prevent duplicates - check by key, bucket, region, and profile
        const exists = state.favorites.some(i =>
          i.key === item.key &&
          i.bucket === item.bucket &&
          i.region === item.region &&
          i.profileId === item.profileId
        );
        if (exists) return state;
        return { favorites: [...state.favorites, item] };
      }),
      
      removeFavorite: (key, bucket, profileId) => set((state) => ({ 
        favorites: state.favorites.filter(i => !(
          i.key === key &&
          (bucket ? i.bucket === bucket : true) &&
          (profileId ? i.profileId === profileId : true)
        )) 
      })),
      
      isFavorite: (key, bucket, profileId) => get().favorites.some(i =>
        i.key === key &&
        (bucket ? i.bucket === bucket : true) &&
        (profileId ? i.profileId === profileId : true)
      ),
      
      clearFavorites: (profileId) => set((state) => ({
        favorites: profileId
          ? state.favorites.filter((item) => item.profileId !== profileId)
          : []
      })),

      clearRecent: (profileId) => set((state) => ({
        recentItems: profileId
          ? state.recentItems.filter((item) => item.profileId !== profileId)
          : []
      })),

      clearHistory: (profileId) => set((state) => ({
        recentPaths: profileId
          ? state.recentPaths
          : [],
        recentPathEntries: profileId
          ? state.recentPathEntries.filter((entry) => entry.profileId !== profileId)
          : [],
        recentItems: profileId
          ? state.recentItems.filter((item) => item.profileId !== profileId)
          : [],
      })),
    }),
    {
      name: 'brows3-history',
      merge: (persistedState, currentState) => {
        const persisted = persistedState as Partial<HistoryState> | undefined;
        const legacyRecentPaths = Array.isArray(persisted?.recentPaths) ? persisted.recentPaths : [];
        const persistedRecentPathEntries = Array.isArray(persisted?.recentPathEntries)
          ? persisted.recentPathEntries
          : legacyRecentPaths.map((path) => ({ path }));

        return {
          ...currentState,
          ...persisted,
          recentPathEntries: persistedRecentPathEntries,
        };
      },
    }
  )
);

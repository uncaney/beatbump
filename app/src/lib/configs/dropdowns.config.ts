/* eslint-disable @typescript-eslint/no-empty-function */

export type Label =
	| "View Artist"
	| "Add to Queue"
	| "Play Next"
	| "Add to Playlist"
	| "Favorite"
	| "Start Group Session"
	| "Share Group Session"
	| "Share"
	| "Shuffle Playlist"
	| "Go to Album"
	| "Remove From Favorites"
	| "View Playlist"
	| "Play Song Radio"
	| "Add to Favorites"
	| "Remove From Playlist"
	| "Shuffle"
	| "Up Next"
	| "Related"
	| "Start Playlist"
	| "Edit Playlist"
	| "Start Radio"
	| "Play Album"
	| "Download"
	| "Download to device"
	| "Download offline"
	| "Lyrics"
	| "Invite Group Session"
	| "Album Radio"
	| "Remove from Queue"
	// Player ⋮ menu (lane c8b): sleep timer sheet + keyboard cheat sheet
	| "Minuterie de sommeil"
	| "Raccourcis clavier";

export type Dropdown = TypedDropdownItem<Label>[];
const DROPDOWN_TEXTS: ReadonlyArray<Label> = [
	"View Artist",
	"Add to Queue",
	"Play Next",
	"Add to Playlist",
	"Favorite",
	"Start Group Session",
	"Share Group Session",
	"Share",
	"Shuffle Playlist",
	"Go to Album",
	"Remove From Favorites",
	"View Playlist",
	"Play Song Radio",
	"Add to Favorites",
	"Shuffle",
	"Up Next",
	"Related",
	"Start Playlist",
	"Edit Playlist",
	"Start Radio",
	"Play Album",
	"Album Radio",
	"Download",
	"Download to device",
	"Download offline",
	"Lyrics",
	"Minuterie de sommeil",
	"Raccourcis clavier",
];

export type Icons =
	| "artist"
	| "queue"
	| "playlist-add"
	| "heart"
	| "users"
	| "share"
	| "shuffle"
	| "album"
	| "pause"
	| "x"
	| "explicit"
	| "send"
	| "list"
	| "radio"
	| "play"
	| "edit"
	| "list-plus"
	| "list-music"
	| "volume"
	| "list-video"
	| "download"
	| "dots"
	| "trash"
	| "refresh"
	| "play-circle"
	// Icons present in components/Icon/icons.svg (also used outside dropdowns).
	| "chevron-left"
	| "chevron-right"
	| "clock"
	| "folder"
	| "frown"
	| "home"
	| "image"
	| "import"
	| "minus"
	| "music"
	| "repeat"
	| "repeat-1"
	| "search"
	| "settings"
	| "skip-back"
	| "skip-forward"
	| "trending"
	| "upload"
	| "user";

const DROPDOWN_ICONS: ReadonlyArray<Icons> = [
	"artist",
	"queue",
	"playlist-add",
	"heart",
	"users",
	"share",
	"shuffle",
	"album",
	"x",
	"send",
	"list",
	"radio",
	"play",
	"edit",
	"list-plus",
	"list-music",
	"list-video",
	"download",
	"dots",
	"trash",
	"refresh",
	"play-circle",
] as const;

export type TypedDropdownItem<T extends Label, I extends Icons = Icons> = {
	text: T;
	icon: I extends infer A ? A : I;
	action: (...args: any[]) => Promise<void> | void;
};

export const DROPDOWN_ITEMS: Partial<{
	[Key in Label]: Partial<TypedDropdownItem<Key, Icons>>;
}> = {
	"View Artist": { text: "View Artist", icon: "artist", action: () => { } },
	"Add to Queue": { text: "Add to Queue", icon: "queue", action: () => { } },
	"Play Next": { text: "Play Next", icon: "queue", action: () => { } },
	Favorite: { text: "Favorite", icon: "heart", action: () => { } },
	"Start Group Session": {
		text: "Start Group Session",
		icon: "users",
		action: () => { },
	},
	Share: { text: "Share", icon: "share", action: () => { } },
	"Go to Album": { text: "Go to Album", icon: "album", action: () => { } },
	"Invite Group Session": {
		text: "Invite Group Session",
		icon: "send",
		action: () => { },
	},
	"View Playlist": { text: "View Playlist", icon: "list", action: () => { } },
	"Play Song Radio": {
		text: "Play Song Radio",
		icon: "radio",
		action: () => { },
	},
	"Remove From Playlist": {
		text: "Remove From Playlist",
		icon: "x",
		action: () => { },
	},
	"Add to Playlist": {
		text: "Add to Playlist",
		icon: "list-plus",
		action: () => { },
	},
	"Add to Favorites": {
		text: "Add to Favorites",
		icon: "heart",
		action: () => { },
	},
	"Download": {
		text: "Download",
		icon: "download",
		action: () => { },
	},
	"Download to device": {
		text: "Download to device",
		icon: "download",
		action: () => { },
	},
	"Download offline": {
		text: "Download offline",
		icon: "download",
		action: () => { },
	},
	"Lyrics": {
		text: "Lyrics",
		icon: "list-music",
		action: () => { },
	},
	"Share Group Session": {
		text: "Share Group Session",
		icon: "share",
		action: () => { },
	},
	Shuffle: { text: "Shuffle", icon: "shuffle", action: () => { } },
	"Shuffle Playlist": {
		text: "Shuffle Playlist",
		icon: "shuffle",
		action: () => { },
	},
	"Album Radio": { text: "Album Radio", icon: "album", action: () => { } },
	"Edit Playlist": { icon: "edit", text: "Edit Playlist", action: () => { } },
	"Remove from Queue": {
		icon: "x",
		text: "Remove from Queue",
		action: () => { },
	},
	"Minuterie de sommeil": {
		icon: "clock",
		text: "Minuterie de sommeil",
		action: () => { },
	},
	"Raccourcis clavier": {
		icon: "list",
		text: "Raccourcis clavier",
		action: () => { },
	},
};

export function buildDropdown() {
	const menu: TypedDropdownItem<Label, Icons>[] = [];
	return {
		add: function (
			label?: Label,
			action?: TypedDropdownItem<Label, Icons>["action"],
		) {
			if (!label || !action) return this;
			const item = Object.assign(
				{},
				DROPDOWN_ITEMS[label!],
			) as TypedDropdownItem<Label, Icons>;
			if (item) {
				item.action = action!;
				menu.push(item);
			}
			return this;
		},
		build: function () {
			return menu;
		},
	};
}

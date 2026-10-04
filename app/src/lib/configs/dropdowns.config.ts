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
	// O8 (lane c18b): the former dead "Download offline" entry, now wired
	// (ListItem / Listing / CarouselItem -> $lib/offlineBatch keepItemOffline).
	| "Garder hors-ligne"
	| "Lyrics"
	| "Invite Group Session"
	| "Album Radio"
	| "Remove from Queue"
	// Player ⋮ menu (lane c8b): sleep timer sheet + keyboard cheat sheet
	| "Minuterie de sommeil"
	| "Raccourcis clavier"
	// Queue actions on every track row (lane c9b, P1): French labels.
	| "Lire ensuite"
	| "Ajouter à la file"
	// Album / playlist header ⋮ menu (InfoBox, lane c31a): French labels.
	| "Ajouter à une playlist"
	| "Lecture aléatoire";

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
	"Garder hors-ligne",
	"Lyrics",
	"Minuterie de sommeil",
	"Raccourcis clavier",
	"Lire ensuite",
	"Ajouter à la file",
	"Ajouter à une playlist",
	"Lecture aléatoire",
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
	| "pin"
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
	"pin",
	"dots",
	"trash",
	"refresh",
	"play-circle",
] as const;

/** Libellés affichés, par identifiant de menu (decision 1 : tout en français, tutoiement). */
export const DROPDOWN_LABELS_FR: Record<Label, string> = {
	"View Artist": "Voir l'artiste",
	"Add to Queue": "Ajouter à la file",
	"Play Next": "Lire ensuite",
	"Add to Playlist": "Ajouter à une playlist",
	Favorite: "Favori",
	"Start Group Session": "Lancer une session de groupe",
	"Share Group Session": "Partager la session de groupe",
	Share: "Partager",
	"Shuffle Playlist": "Lecture aléatoire",
	"Go to Album": "Voir l'album",
	"Remove From Favorites": "Retirer des favoris",
	"View Playlist": "Voir la playlist",
	"Play Song Radio": "Radio du titre",
	"Add to Favorites": "Ajouter aux favoris",
	"Remove From Playlist": "Retirer de la playlist",
	Shuffle: "Aléatoire",
	"Up Next": "Suite",
	Related: "Similaires",
	"Start Playlist": "Lire la playlist",
	"Edit Playlist": "Modifier la playlist",
	"Start Radio": "Lancer la radio",
	"Play Album": "Lire l'album",
	Download: "Télécharger",
	"Download to device": "Télécharger sur l'appareil",
	"Garder hors-ligne": "Garder hors-ligne",
	Lyrics: "Paroles",
	"Invite Group Session": "Inviter à la session",
	"Album Radio": "Radio de l'album",
	"Remove from Queue": "Retirer de la file",
	"Minuterie de sommeil": "Minuterie de sommeil",
	"Raccourcis clavier": "Raccourcis clavier",
	"Lire ensuite": "Lire ensuite",
	"Ajouter à la file": "Ajouter à la file",
	"Ajouter à une playlist": "Ajouter à une playlist",
	"Lecture aléatoire": "Lecture aléatoire",
};

/** Texte affiché pour un identifiant de menu (l'identifiant lui-même si inconnu). */
export function fr(label: Label): string {
	return DROPDOWN_LABELS_FR[label] ?? label;
}

export type TypedDropdownItem<T extends Label = Label, I extends Icons = Icons> = {
	/** Texte affiché (français). Le code filtre sur `key`, jamais sur `text`. */
	text: string;
	key?: T;
	icon: I extends infer A ? A : I;
	action: (...args: any[]) => Promise<void> | void;
};

export const DROPDOWN_ITEMS: Partial<{
	[Key in Label]: Partial<TypedDropdownItem<Key, Icons>>;
}> = {
	"View Artist": { text: fr("View Artist"), icon: "artist", action: () => { } },
	"Add to Queue": { text: fr("Add to Queue"), icon: "queue", action: () => { } },
	"Play Next": { text: fr("Play Next"), icon: "queue", action: () => { } },
	Favorite: { text: fr("Favorite"), icon: "heart", action: () => { } },
	"Start Group Session": {
		text: fr("Start Group Session"),
		icon: "users",
		action: () => { },
	},
	Share: { text: fr("Share"), icon: "share", action: () => { } },
	"Go to Album": { text: fr("Go to Album"), icon: "album", action: () => { } },
	"Invite Group Session": {
		text: fr("Invite Group Session"),
		icon: "send",
		action: () => { },
	},
	"View Playlist": { text: fr("View Playlist"), icon: "list", action: () => { } },
	"Play Song Radio": {
		text: fr("Play Song Radio"),
		icon: "radio",
		action: () => { },
	},
	"Remove From Playlist": {
		text: fr("Remove From Playlist"),
		icon: "x",
		action: () => { },
	},
	"Add to Playlist": {
		text: fr("Add to Playlist"),
		icon: "list-plus",
		action: () => { },
	},
	"Add to Favorites": {
		text: fr("Add to Favorites"),
		icon: "heart",
		action: () => { },
	},
	"Download": {
		text: fr("Download"),
		icon: "download",
		action: () => { },
	},
	"Download to device": {
		text: fr("Download to device"),
		icon: "download",
		action: () => { },
	},
	// O8: download the track (or the album's tracks) then pin it.
	"Garder hors-ligne": {
		text: fr("Garder hors-ligne"),
		icon: "pin",
		action: () => { },
	},
	"Lyrics": {
		text: fr("Lyrics"),
		icon: "list-music",
		action: () => { },
	},
	"Share Group Session": {
		text: fr("Share Group Session"),
		icon: "share",
		action: () => { },
	},
	Shuffle: { text: fr("Shuffle"), icon: "shuffle", action: () => { } },
	"Shuffle Playlist": {
		text: fr("Shuffle Playlist"),
		icon: "shuffle",
		action: () => { },
	},
	"Album Radio": { text: fr("Album Radio"), icon: "album", action: () => { } },
	"Edit Playlist": { icon: "edit", text: fr("Edit Playlist"), action: () => { } },
	"Remove from Queue": {
		icon: "x",
		text: fr("Remove from Queue"),
		action: () => { },
	},
	"Minuterie de sommeil": {
		icon: "clock",
		text: fr("Minuterie de sommeil"),
		action: () => { },
	},
	"Raccourcis clavier": {
		icon: "list",
		text: fr("Raccourcis clavier"),
		action: () => { },
	},
	"Lire ensuite": { icon: "play-circle", text: fr("Lire ensuite"), action: () => { } },
	"Ajouter à la file": { icon: "queue", text: fr("Ajouter à la file"), action: () => { } },
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
				item.text = fr(label);
				item.key = label;
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

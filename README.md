
# Beatbump

This project is a continuation of the Beatbump by @snuffyDev.

An alternative frontend for YouTube Music created using Svelte/SvelteKit, and Golang.

<p align="center">
	  <a href="https://www.gnu.org/licenses/agpl-3.0.en.html">
    <img alt="License: AGPLv3" src="https://shields.io/badge/License-AGPL%20v3-blue.svg">
  </a>
  <a href="https://github.com/humanetech-community/awesome-humane-tech">
    <img alt="Awesome Humane Tech" src="https://raw.githubusercontent.com/humanetech-community/awesome-humane-tech/main/humane-tech-badge.svg?sanitize=true">
  </a>
</p>

## Features

- Automix for continued listening
- No ads
- Background play on mobile devices
- Search for artists, playlists, songs, and albums
  - Note that all playback is audio only (for now)
- Local playlist management
  - Stored in-browser with IndexedDB
  - Can save songs individually under 'Favorites'
  - Peer-to-Peer data synchronization (using WebRTC)
- Group Sessions
  - Achieved with WebRTC in a [mesh](https://en.wikipedia.org/wiki/Mesh_networking)
- Uses a custom wrapper around the YouTube Music API

...and so much more!


## Privacy

All data is stored locally on your device. Data synchronization is done using PeerJS, which uses WebRTC for a
Peer-to-Peer connection between browsers.

### Extensions

Privacy is something you shouldn't have to think about. Using the browser extension LibRedirect, you can automatically
redirect YouTube Music links to Beatbump. For more information, please visit the
[LibRedirect Repo](https://github.com/libredirect/libredirect).

### Contributing

Contributions are welcomed

### Running Beatbump

- git clone https://github.com/giwty/Beatbump.git
- docker build . -t beatbump
- docker run 8080:8080 beatbump
- Access http://app.localhost:8080  

As of Nov 2024, Google has removed OAuth authentication from YT Music. This means using this (somewhat cumbersome) method of cookie authentication is the only way to get YT Music working.

Note

Cookies will expire after some time. This means that you will have to run this process again if YT Music stops working and you see 401: Unauthorized in your logs.
Obtaining the Cookies

    Open YT Music in your browser.

    Open the developer tools via View -> Developer -> Developer Tools. Note that this might be named differently based on your browser. It should open a window similar to this: Dev tools

    Navigate to the 'Network' tab
    In the filter bar, type "/browse"
    Now navigate to a page in YT Music that requires authentication, for example, on of your library playlists
    A request will show-up in the table:

Auth request

    Click the request and make sure you are on the 'Headers' tab
    Find the section called 'Request Headers'
    Find the item named 'Cookie' and copy the value. It is VERY important that you copy the exact value. Double check that you do not include any additional spaces or characters at the start/end of the value Cookie value




### Project Inspirations

- [Invidious](https://github.com/iv-org/invidious) - a privacy focused alternative YouTube front end.

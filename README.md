# Pressure Modifiers Console
This project was made for fun, purely. It's a modifier selector for the Roblox game [**"Pressure"**](https://www.roblox.com/games/12411473842/Pressure), the goal is to make an easy modifier preview for the game. This includes selector, a brief description, way to encounter and total percentage.

## How to use?
Visit [this website](https://codedcorerblx.github.io/) here to get started, you may select modifiers as you wish and even share it with your friends! Press "Copy Permalink" to get a shareable URL, or copy it directly from the address bar.

## Future plans
I might create more tools related to Pressure, uncertain what it would be as of now, though.

# Project info
## Structure
```
pressure
├── [D] css
│   └── [F] style.css
├── [D] data
│   ├── [D] v1
│   │   ├── [F] 1-stars.json
│   │   ├── [F] 2-stars.json
│   │   ├── [F] 3-stars.json
│   │   ├── [F] 4-stars.json
│   │   ├── [F] conflict.json
│   │   └── [F] stars-map.json
│   └── [F] versions.json
├── [D] fonts
│   ├── [F] .gitkeep
│   └── [*] Zekton.ttf
├── [F] index.html
└── [D] js
    └── [F] app.js
```

## Details
**Type**: `static`
This project mainly use JSON for data management, such as modifiers list from one to four stars, mapping for each star and such. Everything is handled by `js/app.js`.

## License
[The License for this project can be found here.](https://github.com/codedcorerblx/pressure/blob/main/LICENSE)

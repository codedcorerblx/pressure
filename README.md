# Pressure Modifiers Console
This project was made for fun, purely. It's a modifier selector for the Roblox game [**"Pressure"**](https://www.roblox.com/games/12411473842/Pressure), the goal is to make an easy modifier preview for the game. This includes selector, a brief description, way to encounter and total percentage.

## How to use?
Visit [this website](https://codedcorerblx.github.io/pressure/) here to get started, you may select modifiers as you wish and even share it with your friends! Press "Copy Permalink" to get a shareable URL, or copy it directly from the address bar.

## Future plans
I might create more tools related to Pressure, uncertain what it would be as of now, though.

# Project info
## Structure
```
├── [F] .gitignore
├── [F] LICENSE
├── [F] README.md
├── [D] css
│   └── [F] style.css
├── [D] data
│   ├── [F] config_disable.json
│   ├── [F] config_migration.json
│   ├── [F] config_theme.json
│   ├── [D] v1_0
│   ├── [D] v1_1
│   ├── [D] v1_2
│   └── [F] versions.json
├── [D] fonts
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

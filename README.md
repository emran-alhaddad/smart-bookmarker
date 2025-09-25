# 🧠 Smart Bookmark Organizer

[![Version](https://img.shields.io/badge/version-2.0.0-blue.svg)](https://github.com/yourusername/smart-bookmarks-overhaul-final-v8)
[![Chrome Extension](https://img.shields.io/badge/Chrome-Extension-green.svg)](https://developer.chrome.com/docs/extensions/)
[![License](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

> 🤖 AI-powered Chrome extension that automatically organizes your bookmarks with intelligent categorization and a rich management dashboard.

## ✨ Features

### 🎯 AI-Powered Organization
- **Multi-Provider AI Support**: OpenAI, Google Gemini, Anthropic Claude, uClassify
- **Intelligent Fallback**: Local/offline classification when APIs are unavailable
- **Smart Categorization**: Automatically analyzes bookmark content and context
- **Rate Limiting**: Built-in protection against API rate limits

### 🗂️ Advanced Management
- **Non-Destructive Organization**: Keeps original bookmarks intact while creating organized copies
- **Dynamic Categories**: Creates categories on-demand based on content analysis
- **Hierarchical Structure**: Support for parent-child category relationships
- **Custom Categories**: User-defined categories with emoji and color coding

### 🎨 Rich User Interface
- **Popup Interface**: Quick access with stats, search, and one-click organization
- **Dashboard**: Full-featured management with category sidebar and detailed views
- **Settings Panel**: Comprehensive configuration for AI providers and preferences
- **Responsive Design**: Clean, modern UI with dark/light mode support

### ⚡ Productivity Features
- **Keyboard Shortcuts**: Alt+Shift+B (Cmd+Shift+Y on Mac) for quick bookmarking
- **Real-time Progress**: Live updates during organization process
- **Advanced Search**: Filter bookmarks by category, tags, or content
- **Import/Export**: Backup and restore settings and categories

## 🚀 Installation

### From Chrome Web Store
*Coming soon - extension will be published to the Chrome Web Store*

### Manual Installation (Developer Mode)
1. Clone this repository:
   ```bash
   git clone https://github.com/yourusername/smart-bookmarks-overhaul-final-v8.git
   ```

2. Open Chrome and navigate to `chrome://extensions/`

3. Enable "Developer mode" in the top right corner

4. Click "Load unpacked" and select the extension directory

5. The Smart Bookmark Organizer icon should appear in your toolbar

## 🔧 Configuration

### AI Provider Setup
1. Click the extension icon and select "Settings"
2. Choose your preferred AI classification mode:
   - **Local**: Offline processing (no API key required)
   - **API Auto**: Tries providers in sequence
   - **Specific Provider**: OpenAI, Gemini, Claude, or uClassify

3. Add your API keys for enhanced classification:
   - **OpenAI**: Get key from [OpenAI Platform](https://platform.openai.com/)
   - **Gemini**: Get key from [Google AI Studio](https://makersuite.google.com/)
   - **Claude**: Get key from [Anthropic Console](https://console.anthropic.com/)
   - **uClassify**: Get key from [uClassify](https://www.uclassify.com/)

### Organization Strategy
- **Keep Originals** (Default): Creates organized copies in "🧠 Smart Bookmarks" folder
- **Move Originals**: Reorganizes your actual bookmarks into the smart structure

## 📱 Usage

### Quick Start
1. **Organize Existing Bookmarks**: Click the extension icon → "Organize All Bookmarks"
2. **Add Current Page**: Use keyboard shortcut or click "Add Current Page"
3. **Quick Add URL**: Paste any URL in the popup for instant AI categorization
4. **Browse Dashboard**: Click "Dashboard" for advanced management features

### Advanced Features
- **Search**: Use the search bar to find bookmarks across all categories
- **Custom Categories**: Create your own categories with custom names and emojis
- **Bulk Operations**: Select multiple bookmarks for batch actions
- **Export/Import**: Backup your configuration and share with other devices

## 🏗️ Architecture

### Core Components
```
smart-bookmarks-overhaul-final-v8/
├── manifest.json          # Extension configuration
├── background.js          # Service worker (main logic)
├── ai_service.js         # AI provider integrations
├── popup.html/js/css     # Main popup interface
├── dashboard.html/js/css # Advanced management dashboard
├── options.html/js       # Settings and configuration
└── icons/                # Extension icons
```

### Technology Stack
- **JavaScript ES6+**: Modern JavaScript with async/await
- **Chrome Extensions API**: Bookmarks, storage, tabs, context menus
- **Multiple AI APIs**: OpenAI, Gemini, Claude, uClassify integration
- **CSS3**: Modern styling with CSS Grid, Flexbox, and custom properties
- **Local Storage**: Chrome storage API for settings and cache

## 🤖 AI Classification

The extension uses sophisticated AI to categorize bookmarks based on:
- **URL Analysis**: Domain patterns and path structure
- **Page Content**: Title, description, and meta information
- **Context Clues**: Keywords, tags, and semantic analysis
- **Domain Mapping**: Pre-defined mappings for popular services

### Supported Categories
- **Development**: Programming, DevOps, Frontend, Backend, QA
- **Tools**: AI Tools, Productivity, Design, Analytics
- **Documentation**: Guides, References, APIs, Tutorials
- **Media**: Videos, Images, Audio, Social Media
- **Business**: E-commerce, Marketing, Finance, CRM
- **Learning**: Courses, Articles, Research, News
- **And many more...**

## 🔒 Privacy & Security

- **Local Processing**: Default mode works entirely offline
- **Secure Storage**: API keys encrypted in Chrome's secure storage
- **No Data Collection**: Extension doesn't collect or transmit personal data
- **Optional APIs**: All external AI services are opt-in only
- **Permissions**: Only requests necessary Chrome permissions

## 🛠️ Development

### Prerequisites
- Chrome browser (version 88+)
- Basic understanding of JavaScript and Chrome Extensions

### Setup Development Environment
```bash
# Clone the repository
git clone https://github.com/yourusername/smart-bookmarks-overhaul-final-v8.git
cd smart-bookmarks-overhaul-final-v8

# Load in Chrome
# 1. Open chrome://extensions/
# 2. Enable Developer mode
# 3. Click "Load unpacked"
# 4. Select this directory
```

### File Structure
- `manifest.json` - Extension metadata and permissions
- `background.js` - Service worker handling bookmark operations
- `ai_service.js` - AI classification logic and API integrations
- `popup.*` - Main extension popup interface
- `dashboard.*` - Advanced bookmark management dashboard
- `options.*` - Settings and configuration page

### Contributing
1. Fork the repository
2. Create a feature branch (`git checkout -b feature/amazing-feature`)
3. Commit your changes (`git commit -m 'Add amazing feature'`)
4. Push to the branch (`git push origin feature/amazing-feature`)
5. Open a Pull Request

## 📋 Roadmap

- [ ] **Chrome Web Store Publication**
- [ ] **Firefox Support** - Port to WebExtensions
- [ ] **Sync Across Devices** - Cloud synchronization
- [ ] **Advanced Analytics** - Bookmark usage statistics
- [ ] **Team Sharing** - Share categories and bookmarks
- [ ] **API Integrations** - Pocket, Raindrop.io, etc.
- [ ] **Mobile Companion** - Mobile app for bookmark access

## 🐛 Known Issues

- Large bookmark collections (>5000) may take longer to organize
- Some API providers have rate limits during peak usage
- Certain dynamic websites may not classify perfectly

## 📞 Support

- **Issues**: [GitHub Issues](https://github.com/yourusername/smart-bookmarks-overhaul-final-v8/issues)
- **Feature Requests**: [GitHub Discussions](https://github.com/yourusername/smart-bookmarks-overhaul-final-v8/discussions)
- **Documentation**: [Wiki](https://github.com/yourusername/smart-bookmarks-overhaul-final-v8/wiki)

## 📄 License

This project is licensed under the MIT License - see the [LICENSE](LICENSE) file for details.

## 🙏 Acknowledgments

- Thanks to all AI providers for their classification APIs
- Chrome Extensions team for the robust platform
- Community contributors and beta testers
- Open source projects that inspired this extension

---

<p align="center">
  <strong>Made with ❤️ for bookmark organization enthusiasts</strong>
</p>

<p align="center">
  <a href="#installation">Installation</a> •
  <a href="#configuration">Configuration</a> •
  <a href="#usage">Usage</a> •
  <a href="#development">Development</a> •
  <a href="#support">Support</a>
</p>
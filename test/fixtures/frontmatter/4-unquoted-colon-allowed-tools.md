---
name: browser
description: Open, navigate, screenshot, read, click, and type in web pages from an agent. Use when the user asks to open a URL, preview or verify a running web app, check a page's console, fill a form, click through a web flow, or automate anything in a browser, including "open localhost:3000", "screenshot the page", "what does the console say", "click the submit button". Drives the in-app browser pane of a Superset workspace by default and Browser Use for browsers the panes cannot reach.
argument-hint: URL or what to do in the browser
allowed-tools: Bash(superset:*) Bash(curl:*)
---

# Superset Browser Control

Drive web pages through the browser panes inside a Superset workspace with the
`superset browser` commands. Every operation runs in the pane the user can see,

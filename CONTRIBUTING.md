# Contributing

Thank you for considering contributing to the HLSF Cognition Engine! This document describes how to set up a local development environment, run checks, and propose changes.

## Development workflow

1. **Install dependencies**
   ```bash
   npm install
   ```

2. **Start the development server**
   ```bash
   npm run dev
   ```
   Vite will serve the application at `http://localhost:5173` with hot module replacement enabled.

3. **Run linting and formatting**
   ```bash
   npm run lint
   npm run format
   ```

4. **Build for production**
   ```bash
   npm run build
   ```

## Coding standards

- TypeScript is used across the front-end. Prefer explicit types when adding new modules.
- Follow the ESLint and Prettier rules configured in the repository.
- Co-locate module-specific styles when practical, and import them from `src/main.ts` or feature modules.

## Commit and PR guidelines

- Create feature branches for your work.
- Keep commits focused and descriptive.
- Update documentation (README, architecture notes) alongside code changes when behaviour or setup steps change.
- Ensure the application builds and lint checks pass before submitting a pull request.

## Before opening a PR

- [ ] Run `npm run lint` to ensure TypeScript code follows the style guide.
- [ ] Run `npm test` to execute the Node-based test suite.
- [ ] If you touched `hlsf_partition.py` or the scripts directory, run `pytest` from the repo root.
- [ ] Add or update tests that cover any new behaviour.
- [ ] Ensure non-trivial functions include a short comment or docstring describing their purpose.

## Reporting issues

If you encounter bugs or have feature ideas, open an issue detailing:

- Steps to reproduce (if applicable)
- Expected vs actual behaviour
- Screenshots or logs that help illustrate the problem

We appreciate your contributions!

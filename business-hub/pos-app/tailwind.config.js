/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: { extend: { colors: { brand: { 50: '#eef6f5', 100: '#d5e9e6', 500: '#1f7a72', 600: '#17635c', 700: '#134f4a', 900: '#0f2f2d' } } } },
  plugins: [],
};

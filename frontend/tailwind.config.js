/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{js,ts,jsx,tsx}'],
  darkMode: 'class',
  theme: {
    extend: {
      colors: {
        outlook: {
          blue: '#0078d4',
          darkblue: '#005a9e',
          lightblue: '#deecf9',
          sidebar: '#f3f2f1',
          border: '#e1dfdd',
          text: '#323130',
          subtle: '#605e5c',
        }
      }
    }
  },
  plugins: []
}

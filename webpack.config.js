/* eslint-disable @typescript-eslint/no-var-requires */
const path = require('path')
const HtmlWebpackPlugin = require('html-webpack-plugin')

module.exports = {
  mode: 'development',
  entry: './src/view/index.tsx',
  output: {
    path: path.join(__dirname, 'dist'),
    filename: 'bundle.js'
  },
  devtool: 'inline-source-map',
  module: {
    rules: [
      {
        test: /\.tsx$|\.ts$/,
        use: 'babel-loader',
        exclude: /node_modules/
      },
      {
        test: /\.css$/,
        use: [
          { loader: 'style-loader' },
          {
            loader: 'css-loader',
            options: {
              url: true,
              import: true,
              sourceMap: true,
              modules: {
                exportGlobals: true,
                localIdentName: '[folder]__[local]--[hash:base64:5]',
              },
              localsConvention: 'camelCase'
            }
          }
        ]
      }
    ]
  },
  plugins: [
    new HtmlWebpackPlugin({
      template: './src/view/index.html'
    })
  ],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, 'src'),
      "assets": path.resolve(__dirname, 'src/view/assets'), 
      "store": path.resolve(__dirname, 'src/view/store'),
      "components": path.resolve(__dirname, 'src/view/components'),
      "utils": path.resolve(__dirname, 'src/view/utils')
    },
    extensions: ['.tsx', '.ts', '.js']
  },
  devServer: {
    contentBase: './dist'
  }
}

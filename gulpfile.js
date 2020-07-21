const gulp = require('gulp')

function rebuildService() {

  return Promise.resolve()
}

gulp.task('rebuild', rebuildService)

gulp.watch('src/service', rebuildService)
<template>
  <div id="app">
    <TheSidebar/>
    <TheNotes/>
    <TheNote/>
  </div>
</template>

<script>
import TheSidebar from './components/TheSidebar'
import TheNotes from './components/TheNotes'
import TheNote from './components/TheNote'

export default {
  name: "App",

  components: {
    TheSidebar,
    TheNotes,
    TheNote,
  }
}
</script>

<style>
:root {
  font-size: 10px;
}

body {
  margin: 0px;
}

input {
  outline: none;
  border: none;
}

ul {
  list-style: none;
  padding-left: 0px;
}

#app {
  display: grid;
  grid-template-columns: 11% 17% 72%;
  grid-template-rows: 100vh;
}

</style>
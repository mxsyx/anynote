const remote = window.electron.remote
const { Menu, MenuItem } = remote

const menus = {
  collapseNote: new Menu(),
  collapseStar: new Menu(),
  collapseTag: new Menu()
}

menus.collapseNote.append(
  new MenuItem({
    label: '新建文件夹',
    click: () => {
      console.log('clicked')
    }
  })
)

export function popupCollapseNote(
  e: React.MouseEvent<HTMLUListElement, MouseEvent>
): void {
  e.preventDefault()
  menus.collapseNote.popup()
}

export function popupCollapseStar(
  e: React.MouseEvent<HTMLUListElement, MouseEvent>
): void {
  e.preventDefault()
  menus.collapseStar.popup()
}

export function popupCollapseTag(
  e: React.MouseEvent<HTMLUListElement, MouseEvent>
): void {
  e.preventDefault()
  menus.collapseTag.popup()
}

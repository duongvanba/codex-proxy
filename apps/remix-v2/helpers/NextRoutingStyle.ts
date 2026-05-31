import { DefineRouteFunction } from '@remix-run/dev/dist/config/routes'
import fs from 'node:fs'

export type RouteMetadata = {
    path: string
    level_layout: number
    nested_layout: boolean
    is_page: boolean
    children: RouteMetadata[]
}

export class NextRoutingStyle {

    constructor(private base_path: string, private debug = false) {}

    #caculate_route(metadata: RouteMetadata) {
        return metadata
            .path
            .split('/')
            .slice(-metadata.level_layout - 1)
            .map(name => (
                name
                .replace('/page.tsx', '')
                .replace('.page.tsx', '')
                .replace('page.tsx', '')
            ))
            .map(name => {
                if (name.startsWith('(') && name.endsWith(')')) return ''
                if (name.startsWith('[') && name.endsWith(']')) return `:${name.replace('[', '').replace(']', '')}`
                return name
            })
            .filter(name => name != '')
            .map(name => name.replaceAll('//', '/'))
            .join('/')
    }

    #discovery_path(path: string = '', prev_level_layout: number = 0): RouteMetadata {

        const base_path = `./${this.base_path}${path}`
        const has_same_level_layout = (() => {
            if (path == '') return true
            const current_dir = base_path.split('/').slice(0, -1).join('/')
            const list = fs.readdirSync(current_dir)
            return list.includes('layout.tsx') || list.includes('root.tsx')
        })()
        const level_layout = has_same_level_layout ? 0 : prev_level_layout + 1

        if (path.endsWith('page.tsx')) return {
            path,
            level_layout,
            nested_layout: false,
            is_page: true,
            children: []
        }
        const nested_files = fs.readdirSync(base_path).filter(f => !f.startsWith('.'))
        const dirs = nested_files.filter(name => (
            name.endsWith('page.tsx')
            || !fs.statSync(base_path + '/' + name).isFile()
        ))

        return {
            path,
            level_layout,
            nested_layout: nested_files.includes('layout.tsx'),
            is_page: path.endsWith('.page.tsx'),
            children: dirs.map(name => this.#discovery_path(path + '/' + name, level_layout))
        }
    }

    build_routes() {
        return this.#discovery_path()
    }

    #is_dynamic_path(path: string) {
        return (
            path.match(/\[[a-zA_Z0-9_]+\](\/|\.)page\.tsx/)
            || path.match(/\[[a-zA_Z0-9_]+\]$/)
        )
    }

    apply_routes(metadata: RouteMetadata, cb: DefineRouteFunction) {

        const process_children = () => {
            // Static pages
            for (const c of metadata.children.filter(c => c.is_page && !this.#is_dynamic_path(c.path))) {
                cb(this.#caculate_route(c), './' + c.path, { index: true })
            }
            // Static directories
            for (const c of metadata.children.filter(c => c.children.length > 0 && !this.#is_dynamic_path(c.path))) {
                this.apply_routes(c, cb)
            }
            // Dynamic directories
            for (const c of metadata.children.filter(c => c.children.length > 0 && this.#is_dynamic_path(c.path))) {
                this.apply_routes(c, cb)
            }
            // Dynamic pages
            for (const c of metadata.children.filter(c => c.is_page && this.#is_dynamic_path(c.path))) {
                cb(this.#caculate_route(c), './' + c.path, { index: true })
            }
        }

        if (metadata.path != '' && metadata.nested_layout) {
            cb(
                this.#caculate_route(metadata),
                './' + metadata.path + '/layout.tsx',
                process_children
            )
        } else {
            process_children()
        }

        if (metadata.path == '') {
            cb('*', './404.tsx', { index: true })
        }
    }
}
